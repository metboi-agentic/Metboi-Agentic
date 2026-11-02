// The console's browser module must build exactly what the SDK and spl-token build, and its RPC gateway must stay narrow.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import anchor from '@coral-xyz/anchor';
import BN from 'bn.js';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { IDL, ownerIx as sdkIx, policyInput, vaultPda as sdkVault, walletPda as sdkWallet } from '../sdk/index.mjs';
import { ataAddress, decodePool, decodeVault, explainFailure, formatAmount, labelTransaction, ownerIx, parseAmount, spentNow, tokenIx, vaultPda, VAULT_SPACE, walletPda, WSOL, U64_MAX } from '../console-src/chain.mjs';
import { createRpcHandler } from '../server/rpc-proxy.mjs';
import { SOL_USDC_POOL, mainnetRpc } from './fork.mjs';

const { damm, dbc } = createRequire(import.meta.url)('./pools.json');
const owner = Keypair.generate().publicKey, agent = Keypair.generate().publicKey, other = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
const vault = vaultPda(owner, 3n);
const policy = { actions: 31, lamportTxCap: 100n, lamportDailyCap: 300n, pools: [other, mint], budgets: [{ mint: new PublicKey(WSOL), txCap: U64_MAX, dailyCap: U64_MAX }, { mint, txCap: 5n, dailyCap: 7n }] };
const sdkPolicy = { ...policy, budgets: policy.budgets.map((b) => ({ mint: b.mint, txCap: b.txCap.toString(), dailyCap: b.dailyCap.toString() })), lamportTxCap: '100', lamportDailyCap: '300' };

const same = (a, b, name) => {
  assert.equal(a.programId.toBase58(), b.programId.toBase58(), name);
  assert.deepEqual([...a.data], [...b.data], `${name} data`);
  const keys = (i) => i.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);
  assert.deepEqual(keys(a), keys(b), `${name} accounts`);
};

test('console: addresses match the SDK', () => {
  assert.equal(vault.toBase58(), sdkVault(owner, 3n).toBase58());
  assert.equal(walletPda(vault).toBase58(), sdkWallet(vault).toBase58());
  assert.equal(ataAddress(owner, mint).toBase58(), getAssociatedTokenAddressSync(mint, owner).toBase58());
  assert.equal(ataAddress(owner, mint, TOKEN_2022_PROGRAM_ID).toBase58(), getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID).toBase58());
});

test('console: every owner instruction matches the SDK byte for byte', () => {
  same(ownerIx.initialize({ owner, id: 3n, agent, agentExpiresAt: 1234, policy }), sdkIx.initialize({ owner, id: 3n, agent, agentExpiresAt: 1234, policy: sdkPolicy }), 'initialize');
  same(ownerIx.updatePolicy({ owner, vault, policy }), sdkIx.updatePolicy({ owner, vault, policy: sdkPolicy }), 'updatePolicy');
  same(ownerIx.setAgent({ owner, vault, agent, agentExpiresAt: 99 }), sdkIx.setAgent({ owner, vault, agent, agentExpiresAt: 99 }), 'setAgent');
  for (const paused of [true, false]) same(ownerIx.setPaused({ owner, vault, paused }), sdkIx.setPaused({ owner, vault, paused }), 'setPaused');
  same(ownerIx.withdrawSol({ owner, vault, to: other, lamports: 77n }), sdkIx.withdrawSol({ owner, vault, to: other, lamports: '77' }), 'withdrawSol');
  const args = { owner, vault, mint, from: other, to: agent, tokenProgram: TOKEN_2022_PROGRAM_ID };
  same(ownerIx.withdrawToken({ ...args, amount: 88n }), sdkIx.withdrawToken({ ...args, amount: '88' }), 'withdrawToken');
});

test('console: token instructions match spl-token byte for byte', () => {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  same(tokenIx.createAtaIdempotent({ payer: agent, owner, mint }), createAssociatedTokenAccountIdempotentInstruction(agent, ata, owner, mint), 'createAta');
  same(tokenIx.syncNative(ata), createSyncNativeInstruction(ata), 'syncNative');
  same(tokenIx.transferChecked({ from: ata, mint, to: other, owner, amount: 55n, decimals: 6 }), createTransferCheckedInstruction(ata, mint, other, owner, 55n, 6), 'transferChecked');
});

test('console: a vault decodes the same as with the IDL, including spend counted now', () => {
  const hour = Math.floor(Date.now() / 1000 / 3600);
  const buckets = Array.from({ length: 25 }, (_, i) => new BN(i === hour % 25 ? 40 : i === (hour + 1) % 25 ? 1000 : 0));
  const meter = { tx_cap: new BN(10), daily_cap: new BN(50), slot_spent: new BN(1), last_slot: new BN(2), last_hour: new BN(hour), buckets };
  const encoded = encodeVault({ owner, agent, id: new BN(3), bump: 254, wallet_bump: 253, paused: true, actions: 31, agent_expires_at: new BN(777), lamports: meter, pools: [other], budgets: [{ mint, meter }] });
  const v = decodeVault(encoded);
  assert.equal(v.owner.toBase58(), owner.toBase58());
  assert.equal(v.agent.toBase58(), agent.toBase58());
  assert.equal(v.id, 3n);
  assert.equal(v.paused, true);
  assert.equal(v.actions, 31);
  assert.equal(v.agentExpiresAt, 777);
  assert.equal(v.pools[0].toBase58(), other.toBase58());
  assert.equal(v.budgets[0].mint.toBase58(), mint.toBase58());
  assert.equal(v.budgets[0].meter.txCap, 10n);
  assert.equal(spentNow(v.lamports), 1040n, 'nothing expired yet');
  assert.equal(spentNow(v.lamports, (hour + 1) * 3600), 40n, 'the next hour bucket is cleared when that hour starts');
  assert.throws(() => decodeVault(Buffer.alloc(100)), /Not a vault/);
  const viaIdl = new anchor.BorshCoder(IDL).accounts.decode('Vault', encoded);
  assert.equal(viaIdl.owner.toBase58(), v.owner.toBase58());
  assert.equal(viaIdl.budgets[0].mint.toBase58(), v.budgets[0].mint.toBase58());
  assert.equal(viaIdl.lamports.buckets[hour % 25].toString(), v.lamports.buckets[hour % 25].toString());
});
function encodeVault(v) {
  const u64 = (x) => new BN(x).toArrayLike(Buffer, 'le', 8);
  const meter = (m) => Buffer.concat([u64(m.tx_cap), u64(m.daily_cap), u64(m.slot_spent), u64(m.last_slot), u64(m.last_hour), ...m.buckets.map(u64)]);
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  return Buffer.concat([
    Buffer.from(IDL.accounts.find((a) => a.name === 'Vault').discriminator), v.owner.toBuffer(), v.agent.toBuffer(), u64(v.id), Buffer.from([v.bump, v.wallet_bump, v.paused ? 1 : 0, v.actions]), u64(v.agent_expires_at), meter(v.lamports),
    u32(v.pools.length), ...v.pools.map((p) => p.toBuffer()), u32(v.budgets.length), ...v.budgets.flatMap((b) => [b.mint.toBuffer(), meter(b.meter)]),
  ]);
}

test('console: pool offsets read the right mints from real mainnet pools', async () => {
  const c = new Connection(mainnetRpc(), 'confirmed');
  const [dlmmInfo, dammInfo, dbcInfo] = await c.getMultipleAccountsInfo([new PublicKey(SOL_USDC_POOL), new PublicKey(damm.pool), new PublicKey(dbc.pool)]);
  const dlmmPool = decodePool(dlmmInfo.owner.toBase58(), dlmmInfo.data);
  assert.equal(dlmmPool.venue, 'DLMM');
  assert.deepEqual(dlmmPool.mints, [WSOL, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v']);
  const dammPool = decodePool(dammInfo.owner.toBase58(), dammInfo.data);
  assert.equal(dammPool.venue, 'DAMM v2');
  assert.equal(dammPool.mints[0], damm.tokenAMint);
  const dbcPool = decodePool(dbcInfo.owner.toBase58(), dbcInfo.data);
  assert.equal(dbcPool.venue, 'DBC');
  assert.equal(dbcPool.mints[0], dbc.baseMint);
  assert.equal(decodePool(Keypair.generate().publicKey.toBase58(), dlmmInfo.data), null);
});

test('console: the vault size matches the program constant', () => {
  assert.equal(VAULT_SPACE, 8 + 32 + 32 + 8 + 1 + 1 + 1 + 1 + 8 + 240 + 4 + 32 * 16 + 4 + (32 + 240) * 8);
});

test('console: amounts convert exactly, with no floating point', () => {
  assert.equal(parseAmount('0.1', 9), 100_000_000n);
  assert.equal(parseAmount('1.000000001', 9), 1_000_000_001n);
  assert.equal(parseAmount('.5', 1), 5n);
  assert.equal(parseAmount('1,000', 0), 1000n);
  assert.equal(parseAmount('18446744073709551615', 0), U64_MAX);
  for (const bad of ['', '.', '-1', '1e9', 'abc', '1.2.3', '18446744073709551616']) assert.throws(() => parseAmount(bad, 0), Error, bad);
  assert.throws(() => parseAmount('1.5', 0), /decimal places/);
  assert.equal(formatAmount(1_500_000_000n, 9), '1.5');
  assert.equal(formatAmount(1_234_567_000_000n, 6), '1,234,567');
  assert.equal(formatAmount(1n, 9), '0.000000001');
  assert.equal(formatAmount(1_234_567n, 6, 2), '1.23');
});

test('console: failures read as sentences', () => {
  assert.match(explainFailure({ InstructionError: [0, { Custom: 6014 }] }, ['Program log: AnchorError occurred. Error Code: InvalidPolicy. Error Number: 6014.']), /too many entries/);
  assert.match(explainFailure({ InstructionError: [0, { Custom: 1 }] }, ['Program log: Error: insufficient funds']), /not enough of this token/);
  assert.match(explainFailure('AccountNotFound', ['Attempt to debit an account but found no record of a prior credit']), /not enough SOL/);
  assert.match(explainFailure('InsufficientFundsForRent', []), /too little SOL/);
});

test('console: transactions get readable labels', () => {
  const programId = IDL.address, target = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
  const swap = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);
  const data = (name, rest = []) => [...IDL.instructions.find((i) => i.name === name).discriminator, ...rest];
  const tx = (signer, instruction) => ({ meta: { err: null }, transaction: { message: { accountKeys: [signer, 'x', 'y', target, programId], instructions: [{ programIdIndex: 4, ...instruction }] } } });
  const label = (t) => labelTransaction(t, 'owner1', (d) => Uint8Array.from(d));
  assert.deepEqual(label(tx('owner1', { data: data('set_paused', [1]), accounts: [] })), { who: 'owner', what: 'Agent paused', failed: false });
  assert.equal(label(tx('owner1', { data: data('set_paused', [0]), accounts: [] })).what, 'Agent resumed');
  assert.equal(label(tx('owner1', { data: data('update_policy'), accounts: [] })).what, 'Limits changed');
  const executed = label(tx('agent1', { data: data('execute', [8, 0, 0, 0, ...swap]), accounts: [0, 1, 2, 3] }));
  assert.equal(executed.who, 'agent');
  assert.equal(executed.what, 'DLMM swap');
  assert.equal(label(tx('stranger', { data: data('update_policy'), accounts: [] })).who, 'other');
});

// ---- RPC gateway

let server, base, seen;
const SECRET = 'https://secret-host.example/?api-key=hunter2';
const startGateway = (options) => new Promise((resolve) => {
  const handler = createRpcHandler({ upstream: SECRET, allowedOrigins: ['https://metboi.com', 'https://www.metboi.com'], ...options });
  const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s));
});
const ORIGIN = { Origin: 'https://metboi.com' };
const READ = { id: 1, method: 'getMultipleAccounts', params: [['a']] };
const call = (url, body, headers = ORIGIN) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
before(async () => {
  server = await startGateway({ fetchImpl: async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ jsonrpc: '2.0', id: seen.body.id, result: 'fine' })); } });
  base = `http://127.0.0.1:${server.address().port}/`;
});
after(() => server?.close());

test('gateway: forwards an allowed read, keeping only the JSON-RPC fields', async () => {
  const res = await call(base, { id: 7, method: 'getMultipleAccounts', params: [['a']], extra: 'dropped' });
  assert.equal((await res.json()).result, 'fine');
  assert.equal(seen.url, SECRET);
  assert.deepEqual(seen.body, { jsonrpc: '2.0', id: 7, method: 'getMultipleAccounts', params: [['a']] });
});

test('gateway: refuses sending, scans, batches, bad JSON, wrong origins, broad requests, and oversize bodies', async () => {
  for (const method of ['sendTransaction', 'getProgramAccounts', 'requestAirdrop', 'getLargestAccounts', undefined]) assert.equal((await call(base, { id: 1, method })).status, 403, String(method));
  assert.equal((await call(base, [READ])).status, 403);
  assert.equal((await call(base, 'not json')).status, 400);
  assert.equal((await call(base, READ, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(base, READ, {})).status, 403, 'a browser always sends Origin on POST');
  assert.equal((await call(base, READ)).status, 200);
  assert.equal((await call(base, READ, { Origin: 'https://www.metboi.com' })).status, 200);
  assert.equal((await call(base, { ...READ, params: ['x'.repeat(20_000)] })).status, 413);
  assert.equal((await call(base, { ...READ, params: [Array(101).fill('a')] })).status, 400);
  assert.equal((await call(base, { id: 1, method: 'getSignaturesForAddress', params: ['a', { limit: 1000 }] })).status, 400);
  assert.equal((await call(base, { id: 1, method: 'getSignaturesForAddress', params: ['a'] })).status, 400);
  assert.equal((await call(base, { id: 1, method: 'getSignatureStatuses', params: [Array(11).fill('a')] })).status, 400);
  assert.equal((await fetch(base)).status, 405);
});

test('gateway: limits each address and the total, without one address using up the total', async () => {
  let t = 0;
  const s = await startGateway({ perIp: 2, total: 4, now: () => t, fetchImpl: async () => new Response('{"result":1}') });
  const url = `http://127.0.0.1:${s.address().port}/`;
  const ask = (ip) => call(url, READ, { ...ORIGIN, 'X-Real-IP': ip }).then((r) => r.status);
  assert.equal(await ask('a'), 200);
  assert.equal(await ask('a'), 200);
  for (let i = 0; i < 20; i++) assert.equal(await ask('a'), 429);
  assert.equal(await ask('b'), 200, 'refused requests must not use up the shared total');
  assert.equal(await ask('b'), 200);
  assert.equal(await ask('c'), 429, 'the total is reached');
  t += 60_000;
  assert.equal(await ask('a'), 200);
  s.close();
});

test('gateway: simulations have their own smaller limit', async () => {
  const s = await startGateway({ simulatePerIp: 1, fetchImpl: async () => new Response('{"result":1}') });
  const url = `http://127.0.0.1:${s.address().port}/`;
  const simulate = () => call(url, { id: 1, method: 'simulateTransaction', params: ['tx'] }).then((r) => r.status);
  assert.equal(await simulate(), 200);
  assert.equal(await simulate(), 429);
  assert.equal((await call(url, READ)).status, 200, 'reads still work');
  s.close();
});

test('gateway: caps concurrent requests and response size', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const busy = await startGateway({ maxInFlight: 1, fetchImpl: async () => { await held; return new Response('{"result":1}'); } });
  const url = `http://127.0.0.1:${busy.address().port}/`;
  const first = call(url, READ);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await call(url, READ)).status, 503);
  release();
  assert.equal((await first).status, 200);
  busy.close();
  const huge = await startGateway({ fetchImpl: async () => new Response(Buffer.alloc(5 * 1024 * 1024, 97)) });
  const res = await call(`http://127.0.0.1:${huge.address().port}/`, READ);
  assert.equal(res.status, 502);
  huge.close();
});

test('gateway: the upstream address never reaches the caller', async () => {
  const s1 = await startGateway({ fetchImpl: async () => { throw new Error(`connect failed ${SECRET}`); } });
  const s2 = await startGateway({ fetchImpl: async () => new Response(`bad gateway ${SECRET}`, { status: 500 }) });
  for (const s of [s1, s2]) {
    const res = await call(`http://127.0.0.1:${s.address().port}/`, READ);
    assert.equal(res.status, 502);
    assert.ok(!(await res.text()).includes('hunter2'));
    s.close();
  }
});

test('gateway: the site source holds no RPC address', async () => {
  const fs = await import('node:fs');
  for (const file of ['web/console.html', 'web/console.bundle.js']) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/api-key=|helius-rpc|mainnet\.helius/.test(text), file);
  }
});
