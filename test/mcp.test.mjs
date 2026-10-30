// Drives the real MCP server over stdio and the real CLI, the way an agent or operator would,
// against one local fork holding the DLMM, DAMM v2, and DBC programs with real pools.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Connection, Keypair, LAMPORTS_PER_SOL as SOL } from '@solana/web3.js';
import { NATIVE_MINT, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { ACTIONS, RULES, fetchVault } from '../sdk/index.mjs';
import { loadDamm, quoteFields } from '../sdk/damm.mjs';
import { loadDbc } from '../sdk/dbc.mjs';
import { LOCAL_RPC, SOL_USDC_POOL, mainnetRpc, poolAccounts, startFork } from './fork.mjs';
import { setupVault } from './helpers.mjs';

const { damm, dbc, dbcToken2022 } = createRequire(import.meta.url)('./pools.json');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = NATIVE_MINT.toBase58();
const DAMM_TOKEN = damm.tokenAMint === WSOL ? damm.tokenBMint : damm.tokenAMint;
const MAX = '18446744073709551615';
const run = promisify(execFile);

let fork, client, env, keyDir, agentKey, ownerKey;

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { isError: !!res.isError, body: JSON.parse(res.content[0].text) };
};
const ok = async (name, args) => {
  const r = await call(name, args);
  assert.equal(r.isError, false, `${name}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const isDecimal = (v) => assert.match(String(v), /^[1-9]\d*$/, `expected a positive decimal amount, got ${v}`);
const remaining = async (mint) => BigInt((await ok('vault_status')).budgets.find((b) => b.mint === mint).remainingToday);

const cliEnv = () => ({ ...process.env, METBOI_RPC: LOCAL_RPC, METBOI_AGENT_KEY: agentKey, METBOI_OWNER_KEY: ownerKey, METBOI_VAULT: env.vault.toBase58() });
// ok:false exits non-zero, and a failed command's JSON is still on stdout.
const cli = async (...args) => JSON.parse((await run('node', ['bin/metboi.mjs', ...args], { env: cliEnv() }).catch((e) => e)).stdout);

before(async () => {
  const mainnet = new Connection(mainnetRpc(), 'confirmed');
  const { state: ds } = await loadDamm(mainnet, damm.pool);
  const clone = [SOL_USDC_POOL, ...await poolAccounts(mainnetRpc()), damm.pool, ds.tokenAVault, ds.tokenBVault, ds.tokenAMint, ds.tokenBMint].map(String);
  for (const p of [dbc, dbcToken2022]) {
    const { state } = await loadDbc(mainnet, p.pool);
    clone.push(p.pool, p.config, String(state.baseMint), String(state.baseVault), String(state.quoteVault));
  }
  fork = await startFork({ programs: [RULES.DLMM.programId, RULES.DAMM_V2.programId, RULES.DBC.programId], accounts: [...new Set(clone)] });
  env = await setupVault(fork.connection, { policy: {
    actions: ACTIONS.ALL, lamportTxCap: 0.3 * SOL, lamportDailyCap: 2 * SOL, pools: [SOL_USDC_POOL, damm.pool, dbc.pool, dbcToken2022.pool],
    budgets: [
      { mint: NATIVE_MINT, txCap: 0.5 * SOL, dailyCap: 5 * SOL }, { mint: USDC, txCap: 1e9, dailyCap: 5e9 }, { mint: DAMM_TOKEN, txCap: MAX, dailyCap: MAX },
      { mint: dbc.baseMint, txCap: MAX, dailyCap: MAX }, { mint: dbcToken2022.baseMint, txCap: MAX, dailyCap: MAX },
    ],
  } });
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metboi-'));
  agentKey = path.join(keyDir, 'agent.json');
  ownerKey = path.join(keyDir, 'owner.json');
  fs.writeFileSync(agentKey, JSON.stringify([...env.agent.secretKey]), { mode: 0o600 });
  fs.writeFileSync(ownerKey, JSON.stringify([...env.owner.secretKey]), { mode: 0o600 });
  client = new Client({ name: 'test', version: '0' });
  const { METBOI_OWNER_KEY: _omit, ...mcpEnv } = cliEnv();
  await client.connect(new StdioClientTransport({ command: 'node', args: ['bin/mcp.mjs'], stderr: 'ignore', env: mcpEnv }));
});

after(async () => {
  await client?.close();
  fork?.stop();
  if (keyDir) fs.rmSync(keyDir, { recursive: true, force: true });
});

test('server exposes all venue tools and no owner tools', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'damm_add_liquidity', 'damm_claim_fees', 'damm_claim_reward', 'damm_close_position', 'damm_create_pool', 'damm_list_positions', 'damm_open_position', 'damm_pool_info', 'damm_quote', 'damm_remove_liquidity', 'damm_swap',
    'dbc_claim_creator_fee', 'dbc_claim_partner_fee', 'dbc_create_config', 'dbc_launch', 'dbc_pool_info', 'dbc_quote', 'dbc_swap', 'dbc_withdraw_leftover', 'dbc_withdraw_surplus',
    'dlmm_add_liquidity', 'dlmm_claim_fees', 'dlmm_claim_reward', 'dlmm_close_position', 'dlmm_create_pool', 'dlmm_limit_cancel', 'dlmm_limit_place', 'dlmm_list_positions', 'dlmm_open_position', 'dlmm_pool_info', 'dlmm_quote', 'dlmm_rebalance', 'dlmm_remove_liquidity', 'dlmm_resize_position', 'dlmm_swap',
    'vault_status',
  ]);
  for (const name of names) assert.doesNotMatch(name, /policy|pause|resume|set_agent|withdraw_sol|withdraw_token/);
});

test('vault_status reports budgets and balances', async () => {
  const body = await ok('vault_status');
  assert.equal(body.isActiveAgent, true);
  assert.deepEqual(body.pools.map((p) => p.venue), ['dlmm', 'damm', 'dbc', 'dbc'], 'each pool names its venue');
  assert.equal(body.balances.find((b) => b.mint === WSOL).amount, String(20 * SOL));
  assert.equal(body.budgets[0].remainingToday, String(5 * SOL));
});

test('dlmm: a swap only simulates by default and moves no funds', async () => {
  const body = await ok('dlmm_swap', { pool: SOL_USDC_POOL, amountIn: String(0.1 * SOL), swapForY: true });
  assert.equal(body.broadcast, false);
  isDecimal(body.expectedOut);
  isDecimal(body.minOut);
  assert.equal((await getAccount(fork.connection, env.walletSol)).amount, BigInt(20 * SOL));
});

test('dlmm: a broadcast swap lands, charges the budget, and over-cap comes back as a named error', async () => {
  const before = await remaining(WSOL);
  const body = await ok('dlmm_swap', { pool: SOL_USDC_POOL, amountIn: String(0.1 * SOL), swapForY: true, broadcast: true });
  assert.ok(body.signature);
  assert.equal(before - (await remaining(WSOL)), BigInt(0.1 * SOL));
  const refused = await call('dlmm_swap', { pool: SOL_USDC_POOL, amountIn: String(0.6 * SOL), swapForY: true, broadcast: true });
  assert.equal(refused.isError, true);
  assert.equal(refused.body.error, 'TxCapExceeded');
  assert.equal(refused.body.broadcast, false);
});

test('dlmm: position lifecycle', async () => {
  const opened = await ok('dlmm_open_position', { pool: SOL_USDC_POOL, amountX: String(0.05 * SOL), amountY: '0', broadcast: true });
  assert.equal((await ok('dlmm_list_positions', { pool: SOL_USDC_POOL }))[0].position, opened.position);
  await ok('dlmm_close_position', { pool: SOL_USDC_POOL, position: opened.position, broadcast: true });
  assert.deepEqual(await ok('dlmm_list_positions', { pool: SOL_USDC_POOL }), []);
});

test('damm: info, quote, swap, and a full position lifecycle', async () => {
  const pool = damm.pool;
  const info = await ok('damm_pool_info', { pool });
  assert.equal([info.tokenA, info.tokenB].includes(WSOL), true);
  const quote = await ok('damm_quote', { pool, inputMint: WSOL, amountIn: String(0.1 * SOL) });
  assert.equal(quote.outToken, DAMM_TOKEN);
  isDecimal(quote.expectedOut);

  const swapped = await ok('damm_swap', { pool, inputMint: WSOL, amountIn: String(0.2 * SOL), broadcast: true });
  assert.ok(swapped.signature);

  const held = (await ok('vault_status')).balances.find((b) => b.mint === DAMM_TOKEN).amount;
  const opened = await ok('damm_open_position', { pool, amount: String(BigInt(held) / 10n), isTokenA: info.tokenA === DAMM_TOKEN, broadcast: true });
  assert.ok(opened.signature);
  const positions = await ok('damm_list_positions', { pool });
  assert.equal(positions.length, 1);
  assert.equal(positions[0].position, opened.position);

  await ok('damm_claim_fees', { pool, position: opened.position, broadcast: true });
  const before = (await getAccount(fork.connection, env.walletSol)).amount;
  await ok('damm_close_position', { pool, position: opened.position, broadcast: true });
  assert.ok((await getAccount(fork.connection, env.walletSol)).amount > before, 'liquidity returns to the wallet');
  assert.deepEqual(await ok('damm_list_positions', { pool }), []);
});

test('dbc: info, quote, and buy and sell on SPL and Token-2022 pools, with Token-2022 balances visible', async () => {
  for (const p of [dbc, dbcToken2022]) {
    const info = await ok('dbc_pool_info', { pool: p.pool });
    assert.equal(info.quoteMint, WSOL);
    assert.equal(info.migrated, false);
    isDecimal((await ok('dbc_quote', { pool: p.pool, amountIn: String(0.01 * SOL) })).expectedOut);
    assert.ok((await ok('dbc_swap', { pool: p.pool, amountIn: String(0.01 * SOL), broadcast: true })).signature);
    const held = (await ok('vault_status')).balances.find((b) => b.mint === p.baseMint);
    assert.ok(held, `balance of ${p.baseMint} should be visible`);
    const sell = String(BigInt(held.amount) / 2n);
    isDecimal((await ok('dbc_quote', { pool: p.pool, amountIn: sell, sell: true })).expectedOut);
    assert.ok((await ok('dbc_swap', { pool: p.pool, amountIn: sell, sell: true, broadcast: true })).signature);
  }
});

test('tools refuse slippage above the client limit', async () => {
  const res = await client.callTool({ name: 'dbc_swap', arguments: { pool: dbc.pool, amountIn: '1000', slippageBps: 5000, broadcast: true } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /slippageBps/);
});

test('cli: agent commands simulate by default and report budgets', async () => {
  assert.equal((await cli('status')).isActiveAgent, true);
  isDecimal((await cli('dlmm-quote', '--pool', SOL_USDC_POOL, '--amount', String(0.01 * SOL), '--side', 'x-to-y')).expectedOut);
  isDecimal((await cli('damm-quote', '--pool', damm.pool, '--input-mint', WSOL, '--amount', String(0.01 * SOL))).expectedOut);
  const before = (await getAccount(fork.connection, env.walletSol)).amount;
  const sim = await cli('dbc-swap', '--pool', dbc.pool, '--amount', String(0.01 * SOL));
  assert.equal(sim.ok, true);
  assert.equal(sim.broadcast, false);
  assert.equal((await getAccount(fork.connection, env.walletSol)).amount, before);
  const sent = await cli('dbc-swap', '--pool', dbc.pool, '--amount', String(0.01 * SOL), '--broadcast');
  assert.ok(sent.signature);
});

test('cli: owner pause stops the agent, and resume restores it', async () => {
  const dry = await cli('pause');
  assert.equal(dry.broadcast, false);
  assert.equal((await fetchVault(fork.connection, env.vault)).paused, false, 'pause without --broadcast changes nothing');
  await cli('pause', '--broadcast');
  assert.equal((await fetchVault(fork.connection, env.vault)).paused, true);
  const refused = await cli('dlmm-swap', '--pool', SOL_USDC_POOL, '--amount', '1000', '--side', 'x-to-y');
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'Paused');
  await cli('resume', '--broadcast');
  assert.equal((await fetchVault(fork.connection, env.vault)).paused, false);
});

test('cli: owner withdraws wSOL and rejects an unknown command', async () => {
  const to = getAssociatedTokenAddressSync(NATIVE_MINT, env.owner.publicKey);
  const { createAssociatedTokenAccountIdempotentInstruction: ata } = await import('@solana/spl-token');
  const { send } = await import('../sdk/index.mjs');
  await send(fork.connection, env.owner, [ata(env.owner.publicKey, to, env.owner.publicKey, NATIVE_MINT)]);
  await cli('withdraw-token', '--mint', WSOL, '--from', env.walletSol.toBase58(), '--to', to.toBase58(), '--amount', String(SOL), '--broadcast');
  assert.equal((await getAccount(fork.connection, to)).amount, BigInt(SOL));
  await assert.rejects(run('node', ['bin/metboi.mjs', 'nope'], { env: cliEnv() }));
});

test('cli: the owner scan runs and reports positions as JSON', async () => {
  const found = await cli('owner-scan');
  assert.deepEqual(Object.keys(found).sort(), ['dammPositions', 'dlmmPositions', 'limitOrders']);
});

test('cli: a failed command explains itself on stdout', async () => {
  const out = await run('node', ['bin/metboi.mjs', 'dlmm-pool', '--pool', damm.pool], { env: cliEnv() }).catch((e) => e);
  assert.equal(out.code, 1);
  assert.equal(JSON.parse(out.stdout).ok, false);
});

test('cli: each swap direction quotes its own side, and a fresh floor under the approved one stops the swap', async () => {
  // X is SOL with 9 decimals, and Y is USDC with 6. The same raw amount is worth far more as USDC, so it buys more.
  const sell = await cli('dlmm-quote', '--pool', String(SOL_USDC_POOL), '--amount', '1000000', '--side', 'x-to-y');
  const buy = await cli('dlmm-quote', '--pool', String(SOL_USDC_POOL), '--amount', '1000000', '--side', 'y-to-x');
  assert.ok(BigInt(buy.expectedOut) > BigInt(sell.expectedOut), 'the sides are swapped');
  const floor = await cli('dlmm-swap', '--pool', String(SOL_USDC_POOL), '--amount', '1000000', '--side', 'x-to-y', '--min-out', '999999999999');
  assert.equal(floor.ok, false);
  assert.match(floor.error, /MinOutNotMet/);
  const fine = await cli('dlmm-swap', '--pool', String(SOL_USDC_POOL), '--amount', '1000000', '--side', 'x-to-y', '--min-out', '1');
  assert.equal(fine.ok, true);
  assert.equal(fine.vault, env.vault.toBase58());
  assert.ok(fine.agentLamportsCost >= 0, 'the simulation reports the SOL the agent key would pay');
});

test('cli: floors follow the slippage asked for on each venue', async () => {
  const within = (q, bps) => {
    const expected = BigInt(q.expectedOut), floor = BigInt(q.minOut);
    const actual = Number((expected - floor) * 100_000n / expected) / 10;
    assert.ok(Math.abs(actual - bps) <= 1, `floor is ${actual} bps under the quote, asked for ${bps}`);
  };
  for (const bps of [100, 300]) {
    within(await cli('dlmm-quote', '--pool', String(SOL_USDC_POOL), '--amount', '10000000', '--side', 'y-to-x', '--slippage', String(bps)), bps);
    within(await cli('damm-quote', '--pool', damm.pool, '--input-mint', WSOL, '--amount', '10000000', '--slippage', String(bps)), bps);
    within(await cli('dbc-quote', '--pool', dbc.pool, '--amount', '10000000', '--slippage', String(bps)), bps);
  }
});

test('damm: quotes get the pool fields the SDK needs for its fee modes', async () => {
  const { state } = await loadDamm(fork.connection, damm.pool);
  for (const [name, value] of Object.entries(quoteFields(state))) assert.notEqual(value, undefined, name);
});

test('cli: a withdrawal shows the cluster, vault, and destination it targets', async () => {
  const to = Keypair.generate().publicKey.toBase58();
  const out = await cli('withdraw-sol', '--to', to, '--lamports', '1000');
  assert.equal(out.vault, env.vault.toBase58());
  assert.equal(out.destination, to);
  assert.equal(typeof out.cluster, 'string');
});

test('dbc: the agent cannot create a launch config when launching is not allowed', async () => {
  const { AgentOps } = await import('../sdk/agent.mjs');
  const swapOnly = await setupVault(fork.connection, { policy: { actions: ACTIONS.SWAP, lamportTxCap: 0, lamportDailyCap: 0, pools: [], budgets: [] }, wsolLamports: 0, walletLamports: 0.01 * SOL });
  const ops = new AgentOps({ connection: fork.connection, agent: swapOnly.agent, vault: swapOnly.vault });
  const out = await ops.dbcCreateConfig({ startMarketCapSol: 30, graduationMarketCapSol: 300 });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'ActionDisabled');
});

test('cli: an agent key cannot run owner commands', async () => {
  const dry = JSON.parse((await run('node', ['bin/metboi.mjs', 'pause'], { env: { ...cliEnv(), METBOI_OWNER_KEY: agentKey } }).catch((e) => e)).stdout);
  assert.equal(dry.ok, false);
  assert.equal(dry.error, 'Unauthorized');
});
