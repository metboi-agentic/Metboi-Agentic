// The full tool set through the agent operations, on pools and tokens created on the fork with the real Meteora programs.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Keypair, LAMPORTS_PER_SOL as SOL, PublicKey, SystemProgram, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID as T22, createAssociatedTokenAccountIdempotentInstruction as ata, createInitializeMint2Instruction,
  createMintToInstruction, createSyncNativeInstruction, getAccount, getAssociatedTokenAddressSync as addr,
} from '@solana/spl-token';
import BN from 'bn.js';
import { ACTIONS, RULES, adaptInstructions, ownerIx, send, simulate, wrapExecute, fetchVault } from '../sdk/index.mjs';
import { AgentOps } from '../sdk/agent.mjs';
import { buildDbcLaunch, buildDbcClaimCreator, buildDbcClaimPartner, loadDbc, buildDbcWithdrawSurplus, buildDbcWithdrawLeftover } from '../sdk/dbc.mjs';
import { buildDammClaim, buildDammCreatePool, loadDamm } from '../sdk/damm.mjs';
import { loadPool } from '../sdk/dlmm.mjs';
import { startFork } from './fork.mjs';
import { attackerTokenAccount, expectVaultError, findExecute, redirect, setupVault } from './helpers.mjs';

const require = createRequire(import.meta.url);
const dbcIdl = require('../idl/meteora/dbc.json');
const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const WSOL = NATIVE_MINT.toBase58();
const MAX = '18446744073709551615';
const WHOLE = 1_000_000n;
const CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });
const LOCK_CLEAR_MS = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fork, c, env, ops, mint;
const pools = [];
const budgets = [{ mint: NATIVE_MINT, txCap: 5 * SOL, dailyCap: 40 * SOL }];
const policy = (actions = ACTIONS.ALL) => ({ actions, lamportTxCap: SOL, lamportDailyCap: 5 * SOL, pools: [...pools], budgets });
const setPolicy = (actions) => send(c, env.owner, [ownerIx.updatePolicy({ owner: env.owner.publicKey, vault: env.vault, policy: policy(actions) })]);
const list = async (pool, budgetMint) => {
  pools.push(String(pool));
  if (budgetMint) budgets.push({ mint: budgetMint, txCap: MAX, dailyCap: MAX });
  await setPolicy();
};
const sent = (name, r) => { assert.equal(r.ok, true, `${name}: ${JSON.stringify(r).slice(0, 400)}`); return r; };
const balance = async (m, program = TOKEN_PROGRAM_ID) => (await getAccount(c, addr(new PublicKey(m), env.wallet, true, program), 'confirmed', program)).amount;

before(async () => {
  fork = await startFork({ programs: [RULES.DLMM.programId, RULES.DAMM_V2.programId, RULES.DBC.programId, METADATA_PROGRAM], accounts: [WSOL] });
  c = fork.connection;
  env = await setupVault(c, { policy: policy(ACTIONS.TRADE_AND_LP), wsolLamports: 50 * SOL, walletLamports: 3 * SOL });
  ops = new AgentOps({ connection: c, agent: env.agent, vault: env.vault });
  const kp = Keypair.generate();
  mint = kp.publicKey;
  const account = addr(mint, env.wallet, true);
  await send(c, env.owner, [
    SystemProgram.createAccount({ fromPubkey: env.owner.publicKey, newAccountPubkey: mint, space: 82, lamports: await c.getMinimumBalanceForRentExemption(82), programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(mint, 6, env.owner.publicKey, null),
    ata(env.owner.publicKey, account, env.wallet, mint),
    createMintToInstruction(mint, account, env.owner.publicKey, 10_000_000n * WHOLE),
  ], [kp]);
  budgets.push({ mint, txCap: MAX, dailyCap: MAX });
  await setPolicy(ACTIONS.TRADE_AND_LP);
});
after(() => fork?.stop());

// ---- DBC launch

let config, launched;

test('dbc: launching is off until the owner turns on the LAUNCH action', async () => {
  const early = await ops.dbcCreateConfig({ startMarketCapSol: 30, graduationMarketCapSol: 400, broadcast: true });
  assert.equal(early.ok, false);
  assert.equal(early.error, 'ActionDisabled', 'the client refuses to spend agent SOL on a config it could not use');
  await setPolicy(ACTIONS.ALL);
  config = sent('config', await ops.dbcCreateConfig({ startMarketCapSol: 30, graduationMarketCapSol: 400, broadcast: true })).config;
  await setPolicy(ACTIONS.TRADE_AND_LP);
  const refused = await ops.dbcLaunch({ config, name: 'Test', symbol: 'TST', uri: 'https://example.com/t.json' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'ActionDisabled', 'the program itself refuses the launch');
  await setPolicy(ACTIONS.ALL);
});

test('dbc: the config always pays fees and leftovers to the vault wallet', async () => {
  const stored = await loadConfig(config);
  assert.ok(stored.feeClaimer.equals(env.wallet));
  assert.ok(stored.leftoverReceiver.equals(env.wallet));
});
const loadConfig = async (k) => new (require('@meteora-ag/dynamic-bonding-curve-sdk').DynamicBondingCurveClient)(c, 'confirmed').state.getPoolConfig(k);

test('dbc: the agent launches an SPL token and the vault wallet is its creator', async () => {
  launched = sent('launch', await ops.dbcLaunch({ config, name: 'Metboi Test', symbol: 'MBT', uri: 'https://example.com/m.json', broadcast: true }));
  const { state } = await loadDbc(c, launched.pool);
  assert.ok(state.creator.equals(env.wallet));
  assert.equal(String(state.baseMint), launched.mint);
});

test('dbc: the agent launches a Token-2022 token', async () => {
  const made = sent('config', await ops.dbcCreateConfig({ startMarketCapSol: 30, graduationMarketCapSol: 400, token2022: true, broadcast: true }));
  const t = sent('launch', await ops.dbcLaunch({ config: made.config, name: 'Metboi 2022', symbol: 'M22', uri: 'https://example.com/n.json', broadcast: true }));
  assert.ok((await loadDbc(c, t.pool)).state.creator.equals(env.wallet));
});

test('attack: a launch cannot name someone else as creator', async () => {
  const built = await buildDbcLaunch({ connection: c, vault: env.vault, agent: env.agent.publicKey, config, name: 'X', symbol: 'X', uri: 'https://example.com/x.json' });
  const launch = findExecute(built.instructions, [RULES.DBC.instructions.initialize_virtual_pool_with_spl_token.disc]);
  const names = RULES.DBC.instructions.initialize_virtual_pool_with_spl_token.accounts;
  await expectVaultError(c, env.agent, 'AccountNotOwnedByWallet', [CU, redirect(launch, names.indexOf('creator'), env.attacker.publicKey)], [built.baseMint]);
});

test('dbc: a new launch stays untradable by the agent until the owner lists it', async () => {
  const refused = await ops.dbcSwap({ pool: launched.pool, amountIn: String(0.1 * SOL) });
  assert.equal(refused.error, 'PoolNotAllowed');
  await list(launched.pool, launched.mint);
  sent('buy', await ops.dbcSwap({ pool: launched.pool, amountIn: String(2 * SOL), broadcast: true }));
  assert.ok((await balance(launched.mint)) > 0n);
});

test('dbc: creator and partner fees reach the vault wallet, and redirects are refused', async () => {
  const attackerSol = env.attackerSol;
  const pool = await loadDbc(c, launched.pool);
  const creatorIxs = await buildDbcClaimCreator({ pool, vault: env.vault, agent: env.agent.publicKey });
  const rule = RULES.DBC.instructions.claim_creator_trading_fee;
  const wrapped = findExecute(creatorIxs, [rule.disc, RULES.DBC.instructions.claim_creator_trading_fee2.disc]);
  assert.ok(wrapped, 'flow should claim the creator fee');
  await expectVaultError(c, env.agent, 'AccountNotOwnedByWallet', [CU, redirect(wrapped, rule.accounts.indexOf('token_b_account'), attackerSol)]);

  const partnerIxs = await buildDbcClaimPartner({ pool, vault: env.vault, agent: env.agent.publicKey });
  const partnerRule = RULES.DBC.instructions.claim_trading_fee;
  const partner = findExecute(partnerIxs, [partnerRule.disc, RULES.DBC.instructions.claim_trading_fee2.disc]);
  assert.ok(partner, 'flow should claim the partner fee');
  await expectVaultError(c, env.agent, 'AccountNotOwnedByWallet', [CU, redirect(partner, partnerRule.accounts.indexOf('token_b_account'), attackerSol)]);

  const before = await balance(WSOL);
  sent('creator fee', await ops.dbcClaimCreatorFee({ pool: launched.pool, broadcast: true }));
  const afterCreator = await balance(WSOL);
  assert.ok(afterCreator > before, 'creator fee should arrive as wSOL');
});

test('attack: surplus and leftover withdrawals cannot be redirected', async () => {
  const pool = await loadDbc(c, launched.pool);
  const surplus = findExecute(await buildDbcWithdrawSurplus({ pool, vault: env.vault, agent: env.agent.publicKey, role: 'creator' }), [RULES.DBC.instructions.creator_withdraw_surplus.disc]);
  assert.ok(surplus);
  await expectVaultError(c, env.agent, 'AccountNotOwnedByWallet', [CU, redirect(surplus, RULES.DBC.instructions.creator_withdraw_surplus.accounts.indexOf('token_quote_account'), env.attackerSol)]);
  const leftover = findExecute(await buildDbcWithdrawLeftover({ pool, vault: env.vault, agent: env.agent.publicKey }), [RULES.DBC.instructions.withdraw_leftover.disc]);
  assert.ok(leftover);
  const attackerBase = await attackerTokenAccount(c, env.attacker, launched.mint, TOKEN_PROGRAM_ID);
  await expectVaultError(c, env.agent, 'AccountNotOwnedByWallet', [CU, redirect(leftover, RULES.DBC.instructions.withdraw_leftover.accounts.indexOf('token_base_account'), attackerBase)]);
});

test('attack: DBC pool ownership and hook launches stay blocked', async () => {
  for (const name of ['transfer_pool_creator', 'initialize_virtual_pool_with_token2022_transfer_hook', 'withdraw_migration_fee', 'create_config']) {
    const ix = dbcIdl.instructions.find((i) => i.name === name);
    const instruction = new TransactionInstruction({ programId: new PublicKey(dbcIdl.address), keys: [], data: Buffer.from(ix.discriminator) });
    await expectVaultError(c, env.agent, 'InstructionNotAllowed', [wrapExecute({ authority: env.agent.publicKey, vault: env.vault, instruction })]);
  }
});

// ---- DLMM

let dlmmPool, position, activeBin;
const PRICE = 0.0001; // wSOL per token.

test('dlmm: the agent creates a pool, and it stays unusable until listed', async () => {
  const made = sent('pool', await ops.createDlmmPool({ mintX: String(mint), mintY: WSOL, binStep: 25, feeBps: 100, price: PRICE, broadcast: true }));
  dlmmPool = made.pool;
  activeBin = made.activeBin;
  const refused = await ops.openPosition({ pool: dlmmPool, amountX: String(100n * WHOLE), amountY: '0', binsEachSide: 5 });
  assert.equal(refused.error, 'PoolNotAllowed');
  await list(dlmmPool);
});

test('dlmm: a position opens on an exact bin range with a curve strategy', async () => {
  const opened = sent('open', await ops.openPosition({ pool: dlmmPool, amountX: String(1000n * WHOLE), amountY: String(0.5 * SOL), minBin: activeBin - 10, maxBin: activeBin + 10, strategy: 'curve', broadcast: true }));
  position = opened.position;
  const [p] = await ops.positions({ pool: dlmmPool });
  assert.equal(p.lowerBin, activeBin - 10);
  assert.equal(p.upperBin, activeBin + 10);
});

test('dlmm: a position opens from a price range with a bid-ask strategy', async () => {
  const opened = sent('open', await ops.openPosition({ pool: dlmmPool, amountX: '0', amountY: String(0.2 * SOL), minPrice: PRICE * 0.9, maxPrice: PRICE * 0.99, strategy: 'bidask', broadcast: true }));
  assert.ok(opened.lowerBin < activeBin && opened.upperBin < activeBin, JSON.stringify(opened).slice(0, 200));
  await sleep(LOCK_CLEAR_MS);
  sent('close', await ops.closePosition({ pool: dlmmPool, position: opened.position, broadcast: true }));
});

test('dlmm: a range wider than one transaction opens in several', async () => {
  const opened = sent('wide', await ops.openPosition({ pool: dlmmPool, amountX: String(500n * WHOLE), amountY: String(0.2 * SOL), minBin: activeBin - 80, maxBin: activeBin + 80, strategy: 'spot', broadcast: true }));
  const found = (await ops.positions({ pool: dlmmPool })).find((p) => p.position === opened.position);
  assert.equal(found.upperBin - found.lowerBin + 1, 161);
  assert.ok(opened.addSteps.length >= 1);
  assert.ok(BigInt(found.amountX.split('.')[0]) > 0n || BigInt(found.amountY.split('.')[0]) > 0n, 'liquidity should be in the wide position');
  await sleep(LOCK_CLEAR_MS);
  sent('close', await ops.closePosition({ pool: dlmmPool, position: opened.position, broadcast: true }));
});

test('attack: a wide position deposit cannot pull from or pay to another account', async () => {
  const pool = await loadPool(c, dlmmPool);
  const { buildOpenPosition } = await import('../sdk/dlmm.mjs');
  const built = await buildOpenPosition({ pool, vault: env.vault, agent: env.agent.publicKey, amountX: String(10n * WHOLE), amountY: String(0.01 * SOL), minBin: activeBin - 80, maxBin: activeBin + 80 });
  await send(c, env.agent, built.instructions, [built.position]);
  const sets = await built.addAfterInit();
  const rule = RULES.DLMM.instructions.rebalance_liquidity;
  const wrapped = findExecute(sets.flat(), [rule.disc]);
  assert.ok(wrapped, 'wide deposits use rebalance_liquidity');
  await expectVaultError(c, env.agent, 'AccountNotOwnedByWallet', [CU, redirect(wrapped, rule.accounts.indexOf('user_token_y'), env.attackerSol)]);
  await sleep(LOCK_CLEAR_MS);
  sent('close empty', await ops.closePosition({ pool: dlmmPool, position: built.position.publicKey, broadcast: true }));
});

test('dlmm: add to a position, swap through it, claim fees, then remove half', async () => {
  sent('add', await ops.addLiquidity({ pool: dlmmPool, position, amountX: String(100n * WHOLE), amountY: String(0.05 * SOL), broadcast: true }));
  sent('swap', await ops.swap({ pool: dlmmPool, amountIn: String(0.05 * SOL), swapForY: false, broadcast: true }));
  const feeBefore = await balance(mint);
  sent('claim', await ops.claimFees({ pool: dlmmPool, position, broadcast: true }));
  assert.ok((await balance(mint)) >= feeBefore);
  await sleep(LOCK_CLEAR_MS);
  const solBefore = await balance(WSOL);
  sent('remove', await ops.removeLiquidity({ pool: dlmmPool, position, bps: 5000, broadcast: true }));
  assert.ok((await balance(WSOL)) > solBefore, 'half the liquidity returns');
  assert.equal((await ops.positions({ pool: dlmmPool })).some((p) => p.position === position), true, 'position stays open');
});

test('dlmm: a position range can be extended and shrunk', async () => {
  const width = async () => { const p = (await ops.positions({ pool: dlmmPool })).find((x) => x.position === position); return [p.lowerBin, p.upperBin]; };
  const [lower, upper] = await width();
  sent('extend', await ops.resizePosition({ pool: dlmmPool, position, side: 'upper', bins: 10, grow: true, broadcast: true }));
  assert.deepEqual(await width(), [lower, upper + 10]);
  sent('shrink', await ops.resizePosition({ pool: dlmmPool, position, side: 'upper', bins: 10, grow: false, broadcast: true }));
  assert.deepEqual(await width(), [lower, upper]);
});

test('dlmm: rebalance moves the funds into a new range', async () => {
  await sleep(LOCK_CLEAR_MS);
  for (const bad of [{ minBin: 100 }, { minBin: 10, maxBin: 5 }, { binsEachSide: 700 }]) await assert.rejects(ops.rebalance({ pool: dlmmPool, position, ...bad, broadcast: true }), /range|bins|bin/);
  assert.ok((await ops.positions({ pool: dlmmPool })).some((p) => p.position === position), 'a bad range closes nothing');
  const r = sent('rebalance', await ops.rebalance({ pool: dlmmPool, position, binsEachSide: 4, strategy: 'spot', broadcast: true }));
  assert.equal(r.stage, 'open');
  const now = await ops.positions({ pool: dlmmPool });
  assert.equal(now.some((p) => p.position === position), false, 'the old position is closed');
  const fresh = now.find((p) => p.position === r.opened.position);
  assert.equal(fresh.upperBin - fresh.lowerBin + 1, 9);
  position = r.opened.position;
});

test('attack: resizing a position cannot pay rent to someone else', async () => {
  const pool = await loadPool(c, dlmmPool);
  const txs = await pool.decreasePositionLength(new PublicKey(position), require('@meteora-ag/dlmm').ResizeSide.Upper, new BN(1));
  const { wrapExecute: wrap } = await import('../sdk/index.mjs');
  const ix = wrap({ authority: env.agent.publicKey, vault: env.vault, instruction: txs[0].instructions.find((i) => i.programId.toBase58() === RULES.DLMM.programId) });
  const rule = RULES.DLMM.instructions.decrease_position_length;
  await expectVaultError(c, env.agent, 'AccountNotOwnedByWallet', [CU, redirect(ix, rule.accounts.indexOf('rent_receiver'), env.attacker.publicKey)]);
});

test('dlmm: limit orders can be placed and cancelled, and their proceeds stay in the wallet', async () => {
  const kp = Keypair.generate();
  const account = addr(kp.publicKey, env.wallet, true);
  await send(c, env.owner, [
    SystemProgram.createAccount({ fromPubkey: env.owner.publicKey, newAccountPubkey: kp.publicKey, space: 82, lamports: await c.getMinimumBalanceForRentExemption(82), programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(kp.publicKey, 6, env.owner.publicKey, null),
    ata(env.owner.publicKey, account, env.wallet, kp.publicKey),
    createMintToInstruction(kp.publicKey, account, env.owner.publicKey, 1000n * WHOLE),
  ], [kp]);
  const made = sent('pool', await ops.createDlmmPool({ mintX: String(kp.publicKey), mintY: WSOL, binStep: 25, feeBps: 100, price: PRICE, limitOrders: true, broadcast: true }));
  await list(made.pool, kp.publicKey);
  const before = (await getAccount(c, account)).amount;
  const placed = sent('place', await ops.limitPlace({ pool: made.pool, side: 'ask', bin: made.activeBin + 5, amount: String(10n * WHOLE), broadcast: true }));
  assert.equal(before - (await getAccount(c, account)).amount, 10n * WHOLE);
  await sleep(LOCK_CLEAR_MS);
  sent('cancel', await ops.limitCancel({ pool: made.pool, order: placed.order, bin: made.activeBin + 5, broadcast: true }));
  assert.equal((await getAccount(c, account)).amount, before, 'tokens return to the wallet');

  // The owner can do the same while the agent is paused, and the scan finds the order.
  const { buildOwnerLimitCancel, scanWallet } = await import('../sdk/owner.mjs');
  const second = sent('place', await ops.limitPlace({ pool: made.pool, side: 'ask', bin: made.activeBin + 6, amount: String(10n * WHOLE), broadcast: true }));
  assert.ok((await scanWallet({ connection: c, vault: env.vault })).limitOrders.some((o) => o.order === second.order), 'scan finds the order');
  await send(c, env.owner, [ownerIx.setPaused({ owner: env.owner.publicKey, vault: env.vault, paused: true })]);
  await sleep(LOCK_CLEAR_MS);
  for (const set of await buildOwnerLimitCancel({ connection: c, vault: env.vault, owner: env.owner.publicKey, pool: made.pool, order: second.order, bin: made.activeBin + 6 })) await send(c, env.owner, set);
  assert.equal((await getAccount(c, account)).amount, before, 'tokens return to the wallet through the owner path');
  await send(c, env.owner, [ownerIx.setPaused({ owner: env.owner.publicKey, vault: env.vault, paused: false })]);
});

// ---- DAMM v2

let dammPool, dammPosition;

test('damm: creating a pool from vault funds needs LAUNCH, and its funding cannot come from elsewhere', async () => {
  await setPolicy(ACTIONS.TRADE_AND_LP);
  const args = { mintA: String(mint), mintB: WSOL, amountA: String(10_000n * WHOLE), amountB: String(1 * SOL) };
  const refused = await ops.dammCreatePool(args);
  assert.equal(refused.error, 'ActionDisabled');
  await setPolicy(ACTIONS.ALL);
  const built = await buildDammCreatePool({ connection: c, vault: env.vault, agent: env.agent.publicKey, ...args });
  const rule = RULES.DAMM_V2.instructions.initialize_customizable_pool;
  const wrapped = findExecute(built.instructions, [rule.disc]);
  await expectVaultError(c, env.agent, 'AccountNotOwnedByWallet', [CU, redirect(wrapped, rule.accounts.indexOf('creator'), env.attacker.publicKey)], [built.positionNft]);
  const unlisted = await ops.dammCreatePool(args);
  assert.equal(unlisted.error, 'PoolNotAllowed', 'the owner must list the pool address first');
  dammPool = String(unlisted.pool);
  await list(dammPool);
  const made = sent('pool', await ops.dammCreatePool({ ...args, broadcast: true }));
  dammPosition = String(made.position);
});

test('damm: add, swap, claim, partial remove, and close', async () => {
  sent('add', await ops.dammAdd({ pool: dammPool, position: dammPosition, amount: String(500n * WHOLE), isTokenA: true, broadcast: true }));
  sent('swap', await ops.dammSwap({ pool: dammPool, inputMint: WSOL, amountIn: String(0.1 * SOL), broadcast: true }));
  sent('claim', await ops.dammClaim({ pool: dammPool, position: dammPosition, broadcast: true }));
  const before = (await ops.dammPositions({ pool: dammPool }))[0].unlockedLiquidity;
  sent('remove', await ops.dammRemove({ pool: dammPool, position: dammPosition, bps: 5000, broadcast: true }));
  const after = (await ops.dammPositions({ pool: dammPool }))[0].unlockedLiquidity;
  assert.ok(BigInt(after) < BigInt(before));
  sent('close', await ops.dammClose({ pool: dammPool, position: dammPosition, broadcast: true }));
  assert.deepEqual(await ops.dammPositions({ pool: dammPool }), []);
});

test('damm: a position with unclaimed fees cannot be closed', async () => {
  const { buildDammOpen, buildDammSwap } = await import('../sdk/damm.mjs');
  await setPolicy(ACTIONS.ALL);
  let d = await loadDamm(c, dammPool);
  const open = await buildDammOpen({ pool: d, vault: env.vault, agent: env.agent.publicKey, amount: 1000n * WHOLE, isTokenA: true });
  await send(c, env.agent, open.instructions, [open.positionNft]);
  await sleep(1200);
  d = await loadDamm(c, dammPool);
  await send(c, env.agent, (await buildDammSwap({ pool: d, vault: env.vault, agent: env.agent.publicKey, inputMint: WSOL, amountIn: 0.1 * SOL })).instructions);

  d = await loadDamm(c, dammPool);
  const state = await d.client.fetchPositionState(open.position);
  const remove = await d.client.removeAllLiquidity({
    owner: env.wallet, position: open.position, positionNftAccount: open.nftAccount, poolState: d.state, positionState: state,
    tokenAAmountThreshold: new BN(0), tokenBAmountThreshold: new BN(0), vestings: [], currentPoint: new BN(0), pool: d.pool,
    tokenAMint: d.state.tokenAMint, tokenBMint: d.state.tokenBMint, tokenAVault: d.state.tokenAVault, tokenBVault: d.state.tokenBVault, tokenAProgram: d.programA, tokenBProgram: d.programB,
  });
  await send(c, env.agent, adaptInstructions({ authority: env.agent.publicKey, vault: env.vault, instructions: remove.instructions }));

  d = await loadDamm(c, dammPool);
  const after = await d.client.fetchPositionState(open.position);
  assert.ok(after.feeBPending.gtn(0) || after.feeAPending.gtn(0), 'the removal should bank fees in the position');
  const close = await d.client.closePosition({
    owner: env.wallet, pool: d.pool, position: open.position, positionNftMint: after.nftMint, positionNftAccount: open.nftAccount,
  });
  const closeIx = adaptInstructions({ authority: env.agent.publicKey, vault: env.vault, instructions: close.instructions });
  await expectVaultError(c, env.agent, 'PendingFeesNotClaimed', closeIx);

  const claim = await buildDammClaim({ pool: d, vault: env.vault, agent: env.agent.publicKey, position: open.position, nftAccount: open.nftAccount });
  await send(c, env.agent, claim.instructions);
  await send(c, env.agent, closeIx);
  assert.equal(await c.getAccountInfo(open.position), null, 'closing works once fees are claimed');

});

test('owner: the owner can scan and exit every position while the agent is paused', async () => {
  const { buildDammOpen } = await import('../sdk/damm.mjs');
  const { buildOwnerDammClose, buildOwnerDlmmClose, scanWallet } = await import('../sdk/owner.mjs');
  await setPolicy(ACTIONS.ALL);
  let d = await loadDamm(c, dammPool);
  const open = await buildDammOpen({ pool: d, vault: env.vault, agent: env.agent.publicKey, amount: 100n * WHOLE, isTokenA: true });
  await send(c, env.agent, open.instructions, [open.positionNft]);
  const dlmmOpen = sent('dlmm', await ops.openPosition({ pool: dlmmPool, amountX: String(10n * WHOLE), amountY: String(0.01 * SOL), binsEachSide: 3, broadcast: true }));
  await send(c, env.owner, [ownerIx.setPaused({ owner: env.owner.publicKey, vault: env.vault, paused: true })]);
  assert.equal((await ops.dammPositions({ pool: dammPool })).length >= 1, true);

  const found = await scanWallet({ connection: c, vault: env.vault });
  assert.ok(found.dlmmPositions.some((p) => p.position === dlmmOpen.position), 'scan finds the DLMM position');
  assert.ok(found.dammPositions.some((p) => p.position === String(open.position)), 'scan finds the DAMM v2 position');

  await sleep(LOCK_CLEAR_MS);
  for (const p of found.dlmmPositions) for (const set of await buildOwnerDlmmClose({ connection: c, vault: env.vault, owner: env.owner.publicKey, pool: p.pool, position: p.position })) await send(c, env.owner, set);
  for (const p of found.dammPositions) for (const set of await buildOwnerDammClose({ connection: c, vault: env.vault, owner: env.owner.publicKey, pool: p.pool, position: p.position })) await send(c, env.owner, set);
  const left = await scanWallet({ connection: c, vault: env.vault });
  assert.deepEqual([left.dlmmPositions.length, left.dammPositions.length], [0, 0], 'nothing is left');
  await send(c, env.owner, [ownerIx.setPaused({ owner: env.owner.publicKey, vault: env.vault, paused: false })]);
});

test('owner: Token-2022 tokens can be withdrawn', async () => {
  const made = sent('config', await ops.dbcCreateConfig({ startMarketCapSol: 30, graduationMarketCapSol: 400, token2022: true, broadcast: true }));
  const launch = sent('launch', await ops.dbcLaunch({ config: made.config, name: 'Withdraw', symbol: 'WD', uri: 'https://example.com/w.json', broadcast: true }));
  await list(launch.pool, launch.mint);
  sent('buy', await ops.dbcSwap({ pool: launch.pool, amountIn: String(0.1 * SOL), broadcast: true }));
  const mintKey = new PublicKey(launch.mint);
  const from = addr(mintKey, env.wallet, true, T22);
  const to = addr(mintKey, env.owner.publicKey, false, T22);
  const amount = (await getAccount(c, from, 'confirmed', T22)).amount;
  await send(c, env.owner, [ata(env.owner.publicKey, to, env.owner.publicKey, mintKey, T22), ownerIx.withdrawToken({ owner: env.owner.publicKey, vault: env.vault, mint: mintKey, from, to, amount, tokenProgram: T22 })]);
  assert.equal((await getAccount(c, to, 'confirmed', T22)).amount, amount);
});

test('the program refuses an unknown action flag', async () => {
  await assert.rejects(send(c, env.owner, [ownerIx.updatePolicy({ owner: env.owner.publicKey, vault: env.vault, policy: policy(64) })]), /InvalidPolicy/);
  assert.equal((await fetchVault(c, env.vault)).actions, ACTIONS.ALL);
});
