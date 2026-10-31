// End-to-end check on devnet with the deployed program and Meteora's devnet programs.
// Keeps progress in devnet.json, so a run interrupted by a rate limit resumes where it stopped.
// devnet.json holds public addresses and signatures only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Connection, Keypair, LAMPORTS_PER_SOL as SOL, PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram } from '@solana/web3.js';
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction as ata, createMint, createMintToInstruction,
  createSyncNativeInstruction, createTransferInstruction, getAccount, getAssociatedTokenAddressSync as addr,
} from '@solana/spl-token';
import BN from 'bn.js';
import { ACTIONS, PROGRAM_ID, RULES, fetchVault, ownerIx, send, simulate, vaultPda, walletPda, wrapExecute } from '../sdk/index.mjs';
import { buildSwap, loadPool } from '../sdk/dlmm.mjs';
import { loadDamm } from '../sdk/damm.mjs';
import { AgentOps, loadKeypair } from '../sdk/agent.mjs';
import { findExecute, redirect } from '../test/helpers.mjs';

const require = createRequire(import.meta.url);
const dlmmModule = require('@meteora-ag/dlmm');
const DLMM = dlmmModule.default ?? dlmmModule;
const { CpAmm, MIN_SQRT_PRICE, MAX_SQRT_PRICE, getBaseFeeParams, BaseFeeMode } = require('@meteora-ag/cp-amm-sdk');

const root = new URL('..', import.meta.url).pathname;
const stateFile = path.join(root, 'devnet.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : { cluster: 'devnet', program: PROGRAM_ID.toBase58(), txs: {} };
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
const env = fs.readFileSync(path.join(os.homedir(), 'rpc/rpc.devnet.env'), 'utf8');
const rpc = env.split('\n').find((l) => l.startsWith('RPC_SEND=')).slice('RPC_SEND='.length).split(',')[0].split('#')[0].trim();
const c = new Connection(rpc, 'confirmed');
const key = (n) => loadKeypair(path.join(root, `keys/devnet/${n}.json`));
const funder = key('upgrade'), owner = key('owner'), agent = key('agent');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

/** Runs a step once. Later runs reuse the recorded result. */
async function step(name, fn) {
  if (state.txs[name]) return log(`skip ${name}`);
  const sig = await fn();
  state.txs[name] = sig ?? 'done';
  save();
  log(`ok   ${name}`);
}

const DECIMALS = 6;
const WHOLE = 10n ** BigInt(DECIMALS);
const VAULT_ID = BigInt(state.vaultId ?? 0);
const vault = vaultPda(owner.publicKey, VAULT_ID);
const wallet = walletPda(vault);
const walletSol = addr(NATIVE_MINT, wallet, true);
state.vault = vault.toBase58();
state.wallet = wallet.toBase58();
state.owner = owner.publicKey.toBase58();
state.agent = agent.publicKey.toBase58();
state.upgradeAuthority = funder.publicKey.toBase58();
save();

await step('fund_keys', () => send(c, funder, [
  SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: owner.publicKey, lamports: 0.6 * SOL }),
  SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: agent.publicKey, lamports: 0.1 * SOL }),
]));

if (!state.mint) {
  state.mint = (await createMint(c, owner, owner.publicKey, null, DECIMALS)).toBase58();
  save();
  log('ok   create_mint');
}
const mint = new PublicKey(state.mint);
const ownerToken = addr(mint, owner.publicKey);
const walletToken = addr(mint, wallet, true);

await step('mint_supply', () => send(c, owner, [
  ata(owner.publicKey, ownerToken, owner.publicKey, mint),
  createMintToInstruction(mint, ownerToken, owner.publicKey, 1_000_000n * WHOLE),
]));

// Pools are created by the owner, because this is a test mint nobody else trades.
if (!state.dlmmPool) {
  const tx = await DLMM.createCustomizablePermissionlessLbPair2(c, new BN(25), mint, NATIVE_MINT, new BN(-1000), new BN(100), 1, false, owner.publicKey, undefined, false, dlmmModule.ConcreteFunctionType.LiquidityMining);
  state.txs.dlmm_create_pool = await send(c, owner, tx.instructions);
  state.dlmmPool = dlmmModule.deriveCustomizablePermissionlessLbPair(mint, NATIVE_MINT, new PublicKey(RULES.DLMM.programId))[0].toBase58();
  save();
  log('ok   dlmm_create_pool');
}

if (!state.txs.dlmm_owner_lp) {
  const pool = await loadPool(c, state.dlmmPool);
  const active = (await pool.getActiveBin()).binId;
  const position = Keypair.generate();
  const isMintX = pool.tokenX.publicKey.equals(mint);
  const amountMint = new BN(String(100_000n * WHOLE)), amountSol = new BN(0.1 * SOL);
  const tx = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey, user: owner.publicKey,
    totalXAmount: isMintX ? amountMint : amountSol, totalYAmount: isMintX ? amountSol : amountMint,
    strategy: { minBinId: active - 8, maxBinId: active + 8, strategyType: 0 }, slippage: 5,
  });
  state.txs.dlmm_owner_lp = await send(c, owner, tx.instructions, [position]);
  save();
  log('ok   dlmm_owner_lp');
}

if (!state.dammPool) {
  const client = new CpAmm(c);
  const positionNft = Keypair.generate();
  const tokenAAmount = new BN(String(100_000n * WHOLE)), tokenBAmount = new BN(0.1 * SOL);
  const { initSqrtPrice, liquidityDelta } = client.preparePoolCreationParams({ tokenAAmount, tokenBAmount, minSqrtPrice: MIN_SQRT_PRICE, maxSqrtPrice: MAX_SQRT_PRICE });
  const { tx, pool } = await client.createCustomPool({
    payer: owner.publicKey, creator: owner.publicKey, positionNft: positionNft.publicKey, tokenAMint: mint, tokenBMint: NATIVE_MINT, tokenAAmount, tokenBAmount,
    sqrtMinPrice: MIN_SQRT_PRICE, sqrtMaxPrice: MAX_SQRT_PRICE, liquidityDelta, initSqrtPrice,
    poolFees: { baseFee: getBaseFeeParams({ baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear, feeTimeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } }, 9, 1), compoundingFeeBps: 0, padding: 0, dynamicFee: null },
    hasAlphaVault: false, activationType: 1, collectFeeMode: 0, activationPoint: null, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
  });
  state.txs.damm_create_pool = await send(c, owner, tx.instructions, [positionNft]);
  state.dammPool = pool.toBase58();
  save();
  log('ok   damm_create_pool');
}

await step('damm_owner_lp', async () => {
  const d = await loadDamm(c, state.dammPool);
  const positionNft = Keypair.generate();
  const amount = new BN(String(50_000n * WHOLE));
  const quote = d.client.getDepositQuote({ inAmount: amount, isTokenA: true, sqrtPrice: d.state.sqrtPrice, minSqrtPrice: d.state.sqrtMinPrice, maxSqrtPrice: d.state.sqrtMaxPrice });
  const pad = (v) => v.muln(11).divn(10);
  const tx = await d.client.createPositionAndAddLiquidity({
    owner: owner.publicKey, pool: d.pool, positionNft: positionNft.publicKey, liquidityDelta: quote.liquidityDelta,
    maxAmountTokenA: pad(amount), maxAmountTokenB: pad(quote.outputAmount), tokenAAmountThreshold: pad(amount), tokenBAmountThreshold: pad(quote.outputAmount),
    tokenAMint: d.state.tokenAMint, tokenBMint: d.state.tokenBMint, tokenAProgram: d.programA, tokenBProgram: d.programB,
  });
  return send(c, owner, tx.instructions, [positionNft]);
});

const CAP = { tx: 0.03 * SOL, daily: 0.06 * SOL };
const policy = {
  actions: ACTIONS.ALL, lamportTxCap: 0.1 * SOL, lamportDailyCap: 0.3 * SOL, pools: [state.dlmmPool, state.dammPool],
  budgets: [{ mint: NATIVE_MINT, txCap: CAP.tx, dailyCap: CAP.daily }, { mint, txCap: 100n * WHOLE, dailyCap: 1000n * WHOLE }],
};

await step('vault_initialize', async () => {
  const sig = await send(c, owner, [
    ownerIx.initialize({ owner: owner.publicKey, id: VAULT_ID, agent: agent.publicKey, policy }),
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: wallet, lamports: 0.15 * SOL }),
    ata(owner.publicKey, walletSol, wallet, NATIVE_MINT),
    ata(owner.publicKey, walletToken, wallet, mint),
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: walletSol, lamports: 0.1 * SOL }),
    createSyncNativeInstruction(walletSol),
    createTransferInstruction(ownerToken, walletToken, owner.publicKey, 500n * WHOLE),
  ]);
  return sig;
});

const ops = new AgentOps({ connection: c, agent, vault });
const WSOL = NATIVE_MINT.toBase58();
const dlmmPool = await loadPool(c, state.dlmmPool);
const buySide = dlmmPool.tokenY.publicKey.equals(mint); // Spending wSOL means swapping toward the test mint.

const results = state.checks ?? {};
const check = async (name, fn, { repeat = false } = {}) => {
  if (results[name] && !repeat) return log(`skip ${name}`);
  results[name] = await fn();
  state.checks = results;
  save();
  log(`ok   ${name}: ${results[name]}`);
};

// Refusals run first and only simulate, so they spend nothing.
await check('attack_redirect_output', async () => {
  const built = await buildSwap({ pool: dlmmPool, vault, agent: agent.publicKey, amountIn: 0.001 * SOL, swapForY: buySide });
  const swap = findExecute(built.instructions, [RULES.DLMM.instructions.swap.disc, RULES.DLMM.instructions.swap2.disc]);
  const sim = await simulate(c, agent, [redirect(swap, RULES.DLMM.instructions.swap2.accounts.indexOf('user_token_out'), ownerToken)]);
  assert.equal(sim.error, 'AccountNotOwnedByWallet');
  return sim.error;
});
await check('attack_direct_token_transfer', async () => {
  const transfer = createTransferInstruction(walletSol, addr(NATIVE_MINT, owner.publicKey), wallet, 1000);
  const sim = await simulate(c, agent, [wrapExecute({ authority: agent.publicKey, vault, instruction: transfer })]);
  assert.equal(sim.error, 'InstructionNotAllowed');
  return sim.error;
});
await check('attack_agent_withdraw', async () => {
  const sim = await simulate(c, agent, [ownerIx.withdrawSol({ owner: agent.publicKey, vault, to: agent.publicKey, lamports: 1000 })]);
  assert.equal(sim.error, 'Unauthorized');
  return sim.error;
});
await check('attack_wallet_as_position', async () => {
  const pid = dlmmPool.program.programId;
  const active = (await dlmmPool.getActiveBin()).binId;
  const instruction = await dlmmPool.program.methods.initializePosition(active, 5).accountsPartial({
    payer: agent.publicKey, position: wallet, lbPair: dlmmPool.pubkey, owner: wallet, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    eventAuthority: PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], pid)[0], program: pid,
  }).instruction();
  const sim = await simulate(c, agent, [wrapExecute({ authority: agent.publicKey, vault, instruction })]);
  assert.equal(sim.error, 'WalletSlotNotAllowed');
  return sim.error;
});
await check('limit_tx_cap', async () => {
  const r = await ops.swap({ pool: state.dlmmPool, amountIn: String(0.04 * SOL), swapForY: buySide, broadcast: true });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'TxCapExceeded');
  return r.error;
});

const unwrapSig = (name, r) => {
  assert.equal(r.ok, true, `${name}: ${JSON.stringify(r).slice(0, 300)}`);
  return r.signature;
};

await step('agent_dlmm_swap', async () => unwrapSig('dlmm swap', await ops.swap({ pool: state.dlmmPool, amountIn: String(0.01 * SOL), swapForY: buySide, broadcast: true })));
await step('agent_damm_swap', async () => unwrapSig('damm swap', await ops.dammSwap({ pool: state.dammPool, inputMint: WSOL, amountIn: String(0.005 * SOL), broadcast: true })));

await check('budget_after_swaps', async () => {
  const v = await fetchVault(c, vault);
  const spent = v.budgets.find((b) => b.mint.equals(NATIVE_MINT)).spent;
  assert.ok(spent >= BigInt(0.015 * SOL));
  return spent.toString();
});

if (!state.agentPosition) {
  const opened = await ops.openPosition({ pool: state.dlmmPool, amountX: String(5n * WHOLE), amountY: String(0.005 * SOL), binsEachSide: 5, broadcast: true });
  state.txs.agent_dlmm_open = unwrapSig('dlmm open', opened);
  state.agentPosition = opened.position;
  save();
  log('ok   agent_dlmm_open');
}
await step('agent_dlmm_close', async () => {
  await sleep(4000);
  const closed = await ops.closePosition({ pool: state.dlmmPool, position: state.agentPosition, broadcast: true });
  assert.equal(closed.ok, true, JSON.stringify(closed).slice(0, 400));
  return closed.steps.map((s) => s.signature).join(',');
});

await step('owner_pause', () => send(c, owner, [ownerIx.setPaused({ owner: owner.publicKey, vault, paused: true })]));
await check('paused_agent_refused', async () => {
  const r = await ops.swap({ pool: state.dlmmPool, amountIn: String(0.001 * SOL), swapForY: buySide, broadcast: true });
  assert.equal(r.error, 'Paused');
  return r.error;
});
await step('owner_resume', () => send(c, owner, [ownerIx.setPaused({ owner: owner.publicKey, vault, paused: false })]));

await check('final_status', async () => {
  const s = await ops.status();
  assert.equal(s.paused, false);
  return JSON.stringify({ lamports: s.lamports, balances: s.balances, budgets: s.budgets.map((b) => b.remainingToday) });
}, { repeat: true });
log('devnet smoke complete');
process.exit(0);
