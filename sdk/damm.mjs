// DAMM v2 actions for the vault wallet. The Meteora SDK builds them, and the vault wrapper adapts them.
import { createRequire } from 'node:module';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getMint } from '@solana/spl-token';
import BN from 'bn.js';
import { adaptInstructions, walletPda } from './index.mjs';

const { CpAmm, BaseFeeMode, MIN_SQRT_PRICE, MAX_SQRT_PRICE, derivePositionAddress, derivePositionNftAccount, getBaseFeeParams, getTokenProgram, getUnClaimLpFee } = createRequire(import.meta.url)('@meteora-ag/cp-amm-sdk');

export async function loadDamm(connection, address) {
  const client = new CpAmm(connection);
  const pool = new PublicKey(address);
  const state = await client.fetchPoolState(pool);
  const [a, b] = await Promise.all([getMint(connection, state.tokenAMint, undefined, getTokenProgram(state.tokenAFlag)), getMint(connection, state.tokenBMint, undefined, getTokenProgram(state.tokenBFlag))]);
  // Passing mint info lets quotes account for Token-2022 transfer fees.
  const { epoch } = await connection.getEpochInfo();
  const infoFor = (mint, program) => (program.equals(TOKEN_2022_PROGRAM_ID) ? { mint, currentEpoch: epoch } : undefined);
  const programA = getTokenProgram(state.tokenAFlag);
  const programB = getTokenProgram(state.tokenBFlag);
  return { client, connection, pool, state, decimalsA: a.decimals, decimalsB: b.decimals, programA, programB, infoA: infoFor(a, programA), infoB: infoFor(b, programB) };
}

/** The fields DAMM v2 quotes need. Without them the SDK uses the wrong formula on compounding pools. */
export const quoteFields = (state) => ({ collectFeeMode: state.collectFeeMode, tokenAAmount: state.tokenAAmount, tokenBAmount: state.tokenBAmount, liquidity: state.liquidity });

/** Floors for removing liquidity. A position with nothing left has nothing to quote, so its floors are zero. */
export function withdrawFloors({ client, state, infoA, infoB, liquidityDelta, slippageBps }) {
  if (liquidityDelta.isZero()) return { a: new BN(0), b: new BN(0) };
  const out = client.getWithdrawQuote({
    liquidityDelta, sqrtPrice: state.sqrtPrice, minSqrtPrice: state.sqrtMinPrice, maxSqrtPrice: state.sqrtMaxPrice, tokenATokenInfo: infoA, tokenBTokenInfo: infoB, ...quoteFields(state),
  });
  return { a: out.outAmountA.muln(10_000 - slippageBps).divn(10_000), b: out.outAmountB.muln(10_000 - slippageBps).divn(10_000) };
}

const adapt = (vault, agent, tx) => adaptInstructions({ authority: agent, vault, instructions: tx.instructions });

export async function buildDammSwap({ pool, vault, agent, inputMint, amountIn, slippageBps = 100 }) {
  const input = new PublicKey(inputMint);
  const { client, connection, state } = pool;
  const output = input.equals(state.tokenAMint) ? state.tokenBMint : state.tokenAMint;
  const slot = await connection.getSlot();
  const time = await connection.getBlockTime(slot);
  const quote = client.getQuote({
    inAmount: new BN(String(amountIn)), inputTokenMint: input, slippage: slippageBps, poolState: state,
    currentTime: time, currentSlot: slot, tokenADecimal: pool.decimalsA, tokenBDecimal: pool.decimalsB,
    inputTokenInfo: input.equals(state.tokenAMint) ? pool.infoA : pool.infoB,
    outputTokenInfo: input.equals(state.tokenAMint) ? pool.infoB : pool.infoA,
  });
  const tx = await client.swap({
    payer: walletPda(vault), pool: pool.pool, inputTokenMint: input, outputTokenMint: output,
    amountIn: new BN(String(amountIn)), minimumAmountOut: quote.minSwapOutAmount,
    tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint, tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault,
    tokenAProgram: pool.programA, tokenBProgram: pool.programB, referralTokenAccount: null, poolState: state,
  });
  return { instructions: adapt(vault, agent, tx), quote, output };
}

/** Opens a position over the pool's price range from an amount of one token, with the other quoted to match. */
export async function buildDammOpen({ pool, vault, agent, amount, isTokenA = true, slippageBps = 300 }) {
  const { client, state } = pool;
  const positionNft = Keypair.generate();
  const input = new BN(String(amount));
  const deposit = client.getDepositQuote({
    inAmount: input, isTokenA, sqrtPrice: state.sqrtPrice, minSqrtPrice: state.sqrtMinPrice, maxSqrtPrice: state.sqrtMaxPrice,
    inputTokenInfo: isTokenA ? pool.infoA : pool.infoB, outputTokenInfo: isTokenA ? pool.infoB : pool.infoA, ...quoteFields(state),
  });
  const pad = (v) => v.muln(10_000 + slippageBps).divn(10_000);
  const maxA = pad(isTokenA ? input : deposit.outputAmount);
  const maxB = pad(isTokenA ? deposit.outputAmount : input);
  const tx = await client.createPositionAndAddLiquidity({
    owner: walletPda(vault), pool: pool.pool, positionNft: positionNft.publicKey, liquidityDelta: deposit.liquidityDelta,
    maxAmountTokenA: maxA, maxAmountTokenB: maxB, tokenAAmountThreshold: maxA, tokenBAmountThreshold: maxB,
    tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint, tokenAProgram: pool.programA, tokenBProgram: pool.programB,
  });
  return { instructions: adapt(vault, agent, tx), positionNft, position: derivePositionAddress(positionNft.publicKey), nftAccount: derivePositionNftAccount(positionNft.publicKey), deposit };
}

export const dammNftAccount = async (pool, position) => derivePositionNftAccount((await pool.client.fetchPositionState(new PublicKey(position))).nftMint);

export async function listDammPositions({ pool, vault }) {
  const found = await pool.client.getUserPositionByPool(pool.pool, walletPda(vault));
  return found.map(({ position, positionNftAccount, positionState }) => {
    const fees = getUnClaimLpFee(pool.state, positionState);
    return { position, nftAccount: positionNftAccount, unlockedLiquidity: positionState.unlockedLiquidity.toString(), feeA: fees.feeTokenA.toString(), feeB: fees.feeTokenB.toString() };
  });
}

/** Adds to an existing position from an amount of one token. */
export async function buildDammAdd({ pool, vault, agent, position, nftAccount, amount, isTokenA = true, slippageBps = 300 }) {
  const { client, state } = pool;
  const input = new BN(String(amount));
  const deposit = client.getDepositQuote({
    inAmount: input, isTokenA, sqrtPrice: state.sqrtPrice, minSqrtPrice: state.sqrtMinPrice, maxSqrtPrice: state.sqrtMaxPrice,
    inputTokenInfo: isTokenA ? pool.infoA : pool.infoB, outputTokenInfo: isTokenA ? pool.infoB : pool.infoA, ...quoteFields(state),
  });
  const pad = (v) => v.muln(10_000 + slippageBps).divn(10_000);
  const maxA = pad(isTokenA ? input : deposit.outputAmount);
  const maxB = pad(isTokenA ? deposit.outputAmount : input);
  const tx = await client.addLiquidity({
    owner: walletPda(vault), position: new PublicKey(position), pool: pool.pool, positionNftAccount: nftAccount, liquidityDelta: deposit.liquidityDelta,
    maxAmountTokenA: maxA, maxAmountTokenB: maxB, tokenAAmountThreshold: maxA, tokenBAmountThreshold: maxB,
    tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint, tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault, tokenAProgram: pool.programA, tokenBProgram: pool.programB,
  });
  return { instructions: adapt(vault, agent, tx) };
}

/** Removes a share of a position and leaves it open. */
export async function buildDammRemove({ pool, vault, agent, position, nftAccount, bps, slippageBps = 100 }) {
  const { client, connection, state } = pool;
  const key = new PublicKey(position);
  const positionState = await client.fetchPositionState(key);
  const liquidityDelta = positionState.unlockedLiquidity.muln(bps).divn(10_000);
  const floors = withdrawFloors({ client, state, infoA: pool.infoA, infoB: pool.infoB, liquidityDelta, slippageBps });
  const slot = await connection.getSlot();
  const time = await connection.getBlockTime(slot);
  const tx = await client.removeLiquidity({
    owner: walletPda(vault), position: key, pool: pool.pool, positionNftAccount: nftAccount, liquidityDelta,
    tokenAAmountThreshold: floors.a, tokenBAmountThreshold: floors.b,
    tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint, tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault, tokenAProgram: pool.programA, tokenBProgram: pool.programB,
    vestings: [], currentPoint: new BN(state.activationType === 0 ? slot : time),
  });
  return { instructions: adapt(vault, agent, tx) };
}

/** Creates a pool funded from the vault wallet, which also owns the first position. Needs the LAUNCH action. */
export async function buildDammCreatePool({ connection, vault, agent, mintA, mintB, amountA, amountB, feeBps = 100 }) {
  const client = new CpAmm(connection);
  const wallet = walletPda(vault);
  const [a, b] = [new PublicKey(mintA), new PublicKey(mintB)];
  const [infoA, infoB] = await connection.getMultipleAccountsInfo([a, b]);
  const positionNft = Keypair.generate();
  const tokenAAmount = new BN(String(amountA)), tokenBAmount = new BN(String(amountB));
  const { initSqrtPrice, liquidityDelta } = client.preparePoolCreationParams({ tokenAAmount, tokenBAmount, minSqrtPrice: MIN_SQRT_PRICE, maxSqrtPrice: MAX_SQRT_PRICE });
  const { tx, pool } = await client.createCustomPool({
    payer: wallet, creator: wallet, positionNft: positionNft.publicKey, tokenAMint: a, tokenBMint: b, tokenAAmount, tokenBAmount,
    sqrtMinPrice: MIN_SQRT_PRICE, sqrtMaxPrice: MAX_SQRT_PRICE, liquidityDelta, initSqrtPrice,
    poolFees: { baseFee: getBaseFeeParams({ baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear, feeTimeSchedulerParam: { startingFeeBps: feeBps, endingFeeBps: feeBps, numberOfPeriod: 0, totalDuration: 0 } }, 9, 1), compoundingFeeBps: 0, padding: 0, dynamicFee: null },
    hasAlphaVault: false, activationType: 1, collectFeeMode: 0, activationPoint: null, tokenAProgram: infoA.owner, tokenBProgram: infoB.owner,
  });
  return { instructions: adapt(vault, agent, tx), positionNft, pool, position: derivePositionAddress(positionNft.publicKey) };
}

export async function buildDammClaim({ pool, vault, agent, position, nftAccount }) {
  const { client, state } = pool;
  const tx = await client.claimPositionFee({
    owner: walletPda(vault), position, pool: pool.pool, positionNftAccount: nftAccount,
    tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint, tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault,
    tokenAProgram: pool.programA, tokenBProgram: pool.programB,
  });
  return { instructions: adapt(vault, agent, tx) };
}

export async function buildDammClaimReward({ pool, vault, agent, position, nftAccount, rewardIndex = 0 }) {
  const { client, state } = pool;
  const tx = await client.claimReward({
    user: walletPda(vault), position, poolState: state, positionState: await client.fetchPositionState(position),
    positionNftAccount: nftAccount, rewardIndex, isSkipReward: false,
  });
  return { instructions: adapt(vault, agent, tx) };
}

export async function buildDammClose({ pool, vault, agent, position, nftAccount, slippageBps = 100 }) {
  const { client, connection, state } = pool;
  const positionState = await client.fetchPositionState(position);
  const slot = await connection.getSlot();
  const time = await connection.getBlockTime(slot);
  const floors = withdrawFloors({ client, state, infoA: pool.infoA, infoB: pool.infoB, liquidityDelta: positionState.unlockedLiquidity, slippageBps });
  const tx = await client.removeAllLiquidityAndClosePosition({
    owner: walletPda(vault), position, positionNftAccount: nftAccount, poolState: state, positionState,
    tokenAAmountThreshold: floors.a, tokenBAmountThreshold: floors.b, vestings: [],
    currentPoint: new BN(state.activationType === 0 ? slot : time),
  });
  return { instructions: adapt(vault, agent, tx) };
}
