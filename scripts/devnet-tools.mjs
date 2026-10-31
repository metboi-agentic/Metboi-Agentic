// Runs the launch, range, and LP tools on devnet through the agent operations.
// Keeps results in devnet.json under "tools", so an interrupted run resumes.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Connection, LAMPORTS_PER_SOL as SOL, PublicKey, SystemProgram } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { ACTIONS, ownerIx, send } from '../sdk/index.mjs';
import { AgentOps, loadKeypair } from '../sdk/agent.mjs';

const state = JSON.parse(fs.readFileSync('devnet.json'));
state.tools ??= {};
const save = () => fs.writeFileSync('devnet.json', JSON.stringify(state, null, 1));
const rpc = fs.readFileSync('.env.devnet', 'utf8').match(/^METBOI_RPC=(.*)$/m)[1];
const c = new Connection(rpc, 'confirmed');
const key = (n) => loadKeypair(`keys/devnet/${n}.json`);
const funder = key('upgrade'), owner = key('owner'), agent = key('agent');
const ops = new AgentOps({ connection: c, agent, vault: state.vault });
const WSOL = NATIVE_MINT.toBase58();
const LOCK_CLEAR_MS = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs a step once and records what it returned. */
async function step(name, fn) {
  if (state.tools[name]) { console.log(`skip ${name}`); return state.tools[name]; }
  const r = await fn();
  assert.notEqual(r?.ok, false, `${name}: ${JSON.stringify(r).slice(0, 500)}`);
  state.tools[name] = r ?? { ok: true };
  save();
  const sig = r?.signature ?? r?.steps?.at(-1)?.signature ?? r?.opened?.signature ?? '';
  console.log(`ok   ${name} ${sig}`);
  return state.tools[name];
}

const budgets = (extra = []) => [
  { mint: NATIVE_MINT, txCap: 0.03 * SOL, dailyCap: 0.3 * SOL },
  { mint: state.mint, txCap: 100_000_000, dailyCap: 2_000_000_000 },
  ...extra,
];
const MAX = '18446744073709551615';
const setPolicy = (pools, extra) => send(c, owner, [ownerIx.updatePolicy({
  owner: owner.publicKey, vault: state.vault,
  policy: { actions: ACTIONS.ALL, lamportTxCap: 0.1 * SOL, lamportDailyCap: 0.5 * SOL, pools, budgets: budgets(extra) },
})]);

await step('return_funds', () => send(c, funder, [
  SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: owner.publicKey, lamports: 0.2 * SOL }),
  SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: agent.publicKey, lamports: 0.08 * SOL }),
  SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: new PublicKey(state.wallet), lamports: 0.2 * SOL }),
]).then((signature) => ({ signature })));

const basePools = [state.dlmmPool, state.dammPool];
await step('turn_on_launch', () => setPolicy(basePools).then((signature) => ({ signature })));

// DBC launch.
const config = await step('dbc_create_config', () => ops.dbcCreateConfig({ startMarketCapSol: 30, graduationMarketCapSol: 400, broadcast: true }));
const launch = await step('dbc_launch', () => ops.dbcLaunch({ config: config.config, name: 'Metboi Test', symbol: 'MBOI', uri: 'https://example.com/metboi-test.json', broadcast: true }));
const before = await ops.dbcSwap({ pool: launch.pool, amountIn: String(0.001 * SOL) });
assert.equal(before.error, 'PoolNotAllowed', 'a launch must stay untradable until listed');
console.log('ok   launch refused before listing: PoolNotAllowed');
const launchBudget = [{ mint: launch.mint, txCap: MAX, dailyCap: MAX }];
await step('owner_lists_launch', () => setPolicy([...basePools, launch.pool], launchBudget).then((signature) => ({ signature })));
await step('dbc_buy', () => ops.dbcSwap({ pool: launch.pool, amountIn: String(0.02 * SOL), broadcast: true }));
const held = async (mint) => BigInt((await ops.status()).balances.find((b) => b.mint === mint).amount);
await step('dbc_sell', async () => ops.dbcSwap({ pool: launch.pool, amountIn: String((await held(launch.mint)) / 2n), sell: true, broadcast: true }));
await step('dbc_claim_creator', () => ops.dbcClaimCreatorFee({ pool: launch.pool, broadcast: true }));
await step('dbc_claim_partner', () => ops.dbcClaimPartnerFee({ pool: launch.pool, broadcast: true }));

// DLMM range tools.
const active = (await ops.poolInfo(state.dlmmPool)).activeBin;
const open = await step('dlmm_open_exact_range', () => ops.openPosition({ pool: state.dlmmPool, amountX: String(5_000_000), amountY: String(0.005 * SOL), minBin: active - 6, maxBin: active + 6, strategy: 'curve', broadcast: true }));
await step('dlmm_add', () => ops.addLiquidity({ pool: state.dlmmPool, position: open.position, amountX: String(1_000_000), amountY: String(0.001 * SOL), broadcast: true }));
await step('dlmm_extend', () => ops.resizePosition({ pool: state.dlmmPool, position: open.position, side: 'upper', bins: 4, grow: true, broadcast: true }));
await sleep(LOCK_CLEAR_MS);
await step('dlmm_remove_half', () => ops.removeLiquidity({ pool: state.dlmmPool, position: open.position, bps: 5000, broadcast: true }));
const moved = await step('dlmm_rebalance', () => ops.rebalance({ pool: state.dlmmPool, position: open.position, binsEachSide: 3, strategy: 'spot', broadcast: true }));
await sleep(LOCK_CLEAR_MS);
await step('dlmm_close', () => ops.closePosition({ pool: state.dlmmPool, position: moved.opened.position, broadcast: true }));

// DAMM v2 position tools.
const damm = await step('damm_open', () => ops.dammOpen({ pool: state.dammPool, amount: String(5_000_000), isTokenA: true, broadcast: true }));
await step('damm_add', () => ops.dammAdd({ pool: state.dammPool, position: damm.position, amount: String(1_000_000), isTokenA: true, broadcast: true }));
await step('damm_remove_half', () => ops.dammRemove({ pool: state.dammPool, position: damm.position, bps: 5000, broadcast: true }));
await step('damm_claim', () => ops.dammClaim({ pool: state.dammPool, position: damm.position, broadcast: true }));
await step('damm_close', () => ops.dammClose({ pool: state.dammPool, position: damm.position, broadcast: true }));

console.log('final', JSON.stringify((await ops.status()).budgets.map((b) => b.remainingToday)));
console.log('devnet tools complete');
process.exit(0);
