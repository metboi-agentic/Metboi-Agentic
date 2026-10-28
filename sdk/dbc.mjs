// DBC swaps for the vault wallet. Launching and fee claims are not covered yet.
import { createRequire } from 'node:module';
import { Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { adaptInstructions, walletPda } from './index.mjs';

const {
  DynamicBondingCurveClient, buildCurveWithMarketCap, deriveDbcPoolAddress, TokenType, TokenDecimal, TokenAuthorityOption, BaseFeeMode, CollectFeeMode, MigrationOption, MigrationFeeOption, ActivationType,
} = createRequire(import.meta.url)('@meteora-ag/dynamic-bonding-curve-sdk');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const SUPPLY = 1_000_000_000;
const MAX_BPS = 10_000;

export async function loadDbc(connection, address) {
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const pool = new PublicKey(address);
  const raw = await client.state.getPool(pool);
  const state = raw.poolState ?? raw;
  const config = await client.state.getPoolConfig(state.config);
  return { client, connection, pool, raw, state, config };
}

/** sell=false buys base with quote. sell=true sells base for quote. */
export async function buildDbcSwap({ pool, vault, agent, amountIn, sell = false, slippageBps = 100 }) {
  const { client, connection, raw, config } = pool;
  const slot = await connection.getSlot();
  const time = await connection.getBlockTime(slot);
  const quote = client.pool.swapQuote({
    virtualPool: raw, config, swapBaseForQuote: sell, amountIn: new BN(String(amountIn)), slippageBps, hasReferral: false,
    currentPoint: new BN(config.activationType === 0 ? slot : time), eligibleForFirstSwapWithMinFee: false,
  });
  const wallet = walletPda(vault);
  const tx = await client.pool.swap({
    owner: wallet, payer: wallet, pool: pool.pool, amountIn: new BN(String(amountIn)),
    minimumAmountOut: quote.minimumAmountOut, swapBaseForQuote: sell, referralTokenAccount: null,
  });
  return { instructions: adaptInstructions({ authority: agent, vault, instructions: tx.instructions }), quote };
}

/**
 * Creates a curve config signed by the agent key. Fees and leftovers are fixed to the vault wallet here,
 * so a launch through this tool cannot point them anywhere else.
 */
export async function buildDbcConfig({ connection, vault, agent, startMarketCapSol, graduationMarketCapSol, feeBps = 100, creatorFeePercent = 100, token2022 = false }) {
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const wallet = walletPda(vault);
  if (!(Number(feeBps) > 0 && Number(feeBps) < MAX_BPS)) throw new Error('Fee must be between 1 and 9999 bps');
  const params = buildCurveWithMarketCap({
    token: {
      tokenType: token2022 ? TokenType.Token2022 : TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: 9,
      tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: SUPPLY, leftover: 0,
    },
    fee: {
      baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: Number(feeBps), endingFeeBps: Number(feeBps), numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: Number(creatorFeePercent), poolCreationFee: 0, enableFirstSwapWithMinFee: false,
    },
    migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps100, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 0, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 100, creatorLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp, initialMarketCap: Number(startMarketCapSol), migrationMarketCap: Number(graduationMarketCapSol),
  });
  const config = Keypair.generate();
  const tx = await client.partner.createConfig({ ...params, config: config.publicKey, feeClaimer: wallet, leftoverReceiver: wallet, quoteMint: WSOL, payer: new PublicKey(agent) });
  return { instructions: tx.instructions, config };
}

/** Launches a token through the vault. The wallet is the creator and pays rent, metered as SOL spend. Needs the LAUNCH action. */
export async function buildDbcLaunch({ connection, vault, agent, config, name, symbol, uri }) {
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const wallet = walletPda(vault);
  const baseMint = Keypair.generate();
  const key = new PublicKey(config);
  const tx = await client.creator.createPool({ config: key, baseMint: baseMint.publicKey, name, symbol, uri, payer: wallet, poolCreator: wallet });
  return { instructions: adaptInstructions({ authority: agent, vault, instructions: tx.instructions }), baseMint, pool: deriveDbcPoolAddress(WSOL, baseMint.publicKey, key) };
}

const adaptTx = (vault, agent, tx) => adaptInstructions({ authority: agent, vault, instructions: tx.instructions });
const MAX_U64 = new BN('18446744073709551615');

export async function buildDbcClaimCreator({ pool, vault, agent }) {
  const wallet = walletPda(vault);
  return adaptTx(vault, agent, await pool.client.creator.claimCreatorTradingFee({ creator: wallet, payer: wallet, pool: pool.pool, maxBaseAmount: MAX_U64, maxQuoteAmount: MAX_U64 }));
}

export async function buildDbcClaimPartner({ pool, vault, agent }) {
  const wallet = walletPda(vault);
  return adaptTx(vault, agent, await pool.client.partner.claimPartnerTradingFee({ feeClaimer: wallet, payer: wallet, pool: pool.pool, maxBaseAmount: MAX_U64, maxQuoteAmount: MAX_U64 }));
}

export async function buildDbcWithdrawSurplus({ pool, vault, agent, role }) {
  const wallet = walletPda(vault);
  const tx = role === 'partner'
    ? await pool.client.partner.partnerWithdrawSurplus({ feeClaimer: wallet, pool: pool.pool })
    : await pool.client.creator.creatorWithdrawSurplus({ creator: wallet, pool: pool.pool });
  return adaptTx(vault, agent, tx);
}

export async function buildDbcWithdrawLeftover({ pool, vault, agent }) {
  return adaptTx(vault, agent, await pool.client.migration.withdrawLeftover({ payer: walletPda(vault), pool: pool.pool }));
}
