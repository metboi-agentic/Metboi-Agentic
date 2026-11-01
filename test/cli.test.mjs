// Input handling in the CLI and wrapper, plus how send reports a landed failure. Needs no network.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Keypair, SendTransactionError, SystemProgram } from '@solana/web3.js';
import { send } from '../sdk/index.mjs';
import { resolveRange } from '../sdk/dlmm.mjs';
import { loadKeypair } from '../sdk/agent.mjs';
import { Transaction } from '@solana/web3.js';

const run = promisify(execFile);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metboi-cli-'));
const agentFile = path.join(dir, 'agent.json');
fs.writeFileSync(agentFile, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 });
const POOL = Keypair.generate().publicKey.toBase58();
const VAULT = Keypair.generate().publicKey.toBase58();
const env = { PATH: process.env.PATH, METBOI_RPC: 'http://127.0.0.1:9', METBOI_AGENT_KEY: agentFile, METBOI_VAULT: VAULT };
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const refused = async (args, pattern, extraEnv = {}) => {
  const out = await run('node', ['bin/metboi.mjs', ...args], { env: { ...env, ...extraEnv } }).catch((e) => e);
  assert.notEqual(out.code ?? 0, 0, `${args.join(' ')} should exit non-zero`);
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, pattern);
  return parsed;
};

test('cli: a mistyped side is refused, not read as the other direction', async () => {
  for (const side of ['X-to-Y', 'x2y', 'true']) await refused(['dlmm-swap', '--pool', POOL, '--amount', '1', '--side', side], /--side must be x-to-y or y-to-x/);
  await refused(['dlmm-swap', '--pool', POOL, '--amount', '1', '--side'], /--side needs a value/);
  await refused(['damm-open', '--pool', POOL, '--amount', '1', '--side', 'A'], /--side must be a or b/);
  await refused(['dlmm-extend', '--pool', POOL, '--position', POOL, '--side', 'up', '--bins', '1'], /--side must be lower or upper/);
  await refused(['dlmm-limit-place', '--pool', POOL, '--side', 'sell', '--bin', '1', '--amount', '1'], /--side must be ask or bid/);
});

test('cli: a true or false after a switch is refused', async () => {
  await refused(['dbc-swap', '--pool', POOL, '--amount', '1', '--sell', 'true'], /--sell takes no value/);
  await refused(['dbc-swap', '--pool', POOL, '--amount', '1', '--sell', 'false'], /--sell takes no value/);
  await refused(['dbc-create-config', '--start-mc', '1', '--graduation-mc', '2', '--token-2022', 'true'], /--token-2022 takes no value/);
  await refused(['status', '--broadcast', 'yes'], /--broadcast takes no value/);
});

test('cli: unknown flags, and flags a command would ignore, are refused', async () => {
  await refused(['dlmm-swap', '--pool', POOL, '--amount', '1', '--side', 'x-to-y', '--slipage', '50'], /Unknown flag --slipage/);
  await refused(['dlmm-open', '--pool', POOL, '--x', '1', '--y', '1', '--slippage', '50'], /--slippage does not apply/);
  await refused(['dlmm-quote', '--pool', POOL, '--amount', '1', '--side', 'x-to-y', '--min-out', '1'], /--min-out does not apply/);
  await refused(['dlmm-swap', '--pool', POOL, '--amount', '1', '--side', 'x-to-y', '--sell'], /--sell does not apply/);
  await refused(['damm-close', '--pool', POOL, '--position', POOL, '--bps', '5000'], /--bps does not apply to damm-close/);
  await refused(['dbc-swap', '--pool', POOL, '--amount', '1', '--side', 'sell'], /--side does not apply to dbc-swap/);
  await refused(['dlmm-remove', '--pool', POOL, '--position', POOL, '--bps', '5000', '--from', '10'], /--from does not apply to dlmm-remove/);
  await refused(['dlmm-quote', '--pool', POOL, '--amount', '1', '--side', 'x-to-y', '--broadcast'], /--broadcast does not apply to dlmm-quote/);
  await refused(['status', '--owner-key', agentFile], /--owner-key does not apply to status/);
  await refused(['loose'], /Unknown command loose/);
});

test('cli: amounts and basis points must be whole numbers in range', async () => {
  for (const amount of ['-5', '33.3', '1e9', 'abc', '0x10']) await refused(['dlmm-swap', '--pool', POOL, '--amount', amount, '--side', 'x-to-y'], /--amount must be a whole number/);
  for (const bps of ['0', '10001', '33.3', 'all']) await refused(['dlmm-remove', '--pool', POOL, '--position', POOL, '--bps', bps], /--bps must be a whole number/);
  await refused(['dlmm-remove', '--pool', POOL, '--position', POOL, '--bps'], /--bps needs a value/);
  await refused(['dlmm-swap', '--pool', POOL, '--amount', '1', '--side', 'x-to-y', '--slippage', '501'], /--slippage must be a whole number/);
  await refused(['dlmm-swap', '--pool', POOL, '--amount', '1', '--side', 'x-to-y', '--min-out', '1.5'], /--min-out must be a whole number/);
  await refused(['dlmm-create-pool', '--mint-x', POOL, '--mint-y', POOL, '--bin-step', '25', '--fee-bps', '100', '--price', 'high'], /--price must be a positive number/);
});

test('cli: every documented command line passes the flag checks', async () => {
  const skill = fs.readFileSync('skills/metboi-agentic/SKILL.md', 'utf8');
  const setup = fs.readFileSync('skills/metboi-agentic/references/setup.md', 'utf8');
  const lines = [
    ...[...skill.matchAll(/^\|[^|]*\| `([a-z0-9-]+ [^`]*|status)` \|/gm)].map((m) => m[1]),
    ...[...setup.matchAll(/^metboi ([^\n]+)$/gm)].map((m) => m[1]),
    'dlmm-open --pool <a> --x <r> --y <r> --min-bin 1 --max-bin 2 --strategy curve --broadcast',
    'dlmm-rebalance --pool <a> --position <a> --min-price 1 --max-price 2 --broadcast',
    'dlmm-remove --pool <a> --position <a> --bps 5000 --from-bin 1 --to-bin 2',
    'dlmm-swap --pool <a> --amount 1 --side x-to-y --slippage 50 --min-out 1 --broadcast',
    'damm-swap --pool <a> --input-mint <a> --amount 1 --slippage 50 --min-out 1',
    'dbc-swap --pool <a> --amount 1 --sell --slippage 50 --min-out 1',
    'dbc-create-config --start-mc 1 --graduation-mc 2 --fee-bps 100 --creator-fee-percent 50 --token-2022',
    'dlmm-create-pool --mint-x <a> --mint-y <a> --bin-step 25 --fee-bps 100 --price 1 --limit-orders',
    'owner-damm-close --pool <a> --position <a> --slippage 50',
  ];
  assert.ok(lines.length > 45, `found ${lines.length} command lines`);
  for (const line of lines) {
    const args = line.replace(/<[^>]+>/g, POOL).split(/\s+/);
    const out = await run('node', ['bin/metboi.mjs', ...args], { env: { ...env, METBOI_OWNER_KEY: agentFile } }).catch((e) => e);
    assert.ok(!/does not apply|Unknown flag|Unknown command|Unexpected argument/.test(out.stdout), `${line}: ${out.stdout}`);
  }
});

test('cli: a flag wins over the environment', async () => {
  await refused(['status', '--vault', 'not-an-address'], /./);
  await refused(['status', '--rpc', 'not-a-url'], /./);
});

test('cli: a key pasted where a path belongs is never repeated', async () => {
  const secret = JSON.stringify([...Keypair.generate().secretKey]);
  for (const value of [secret, 'one two three four five six seven eight nine ten eleven twelve']) {
    const out = await run('node', ['bin/metboi.mjs', 'status'], { env: { ...env, METBOI_AGENT_KEY: value } }).catch((e) => e);
    assert.equal(out.code, 1);
    for (const stream of [out.stdout, out.stderr]) {
      assert.ok(!stream.includes(value), 'the value must not appear in output');
      assert.ok(!stream.includes(value.slice(0, 20)), 'no part of the value may appear in output');
    }
    assert.match(JSON.parse(out.stdout).error, /Could not read a key/);
  }
  const mcp = await run('node', ['bin/mcp.mjs'], { env: { ...env, METBOI_AGENT_KEY: secret } }).catch((e) => e);
  assert.equal(mcp.code, 1);
  assert.ok(!mcp.stderr.includes(secret.slice(0, 20)));
});

test('cli: a loaded key still signs valid transactions', () => {
  const key = loadKeypair(agentFile);
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: key.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  tx.feePayer = key.publicKey;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.sign(key);
  assert.ok(tx.serialize().length > 0, 'serialize verifies the signature');
});

test('dlmm: half a range is refused, not replaced with the default width', async () => {
  const pool = { getActiveBin: async () => ({ binId: 100 }) };
  await assert.rejects(resolveRange(pool, { minBin: 90 }), /both a minimum and a maximum bin/);
  await assert.rejects(resolveRange(pool, { maxBin: 90 }), /both a minimum and a maximum bin/);
  await assert.rejects(resolveRange(pool, { minPrice: '1' }), /both a minimum and a maximum price/);
  assert.deepEqual(await resolveRange(pool, { minBin: 90, maxBin: 95 }), { lower: 90, upper: 95 });
  assert.deepEqual(await resolveRange(pool, {}), { lower: 90, upper: 110 });
});

const fakeConnection = (confirm) => ({
  getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
  getBalance: async () => 1_000_000,
  simulateTransaction: async () => ({ value: { err: null, logs: [], unitsConsumed: 1, accounts: [{ lamports: 995_000 }] } }),
  sendRawTransaction: async () => 'landed-signature',
  confirmTransaction: confirm,
});
const payer = Keypair.generate();
const transfer = [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })];

test('send: a transaction that lands and fails is an error carrying its signature', async () => {
  const c = fakeConnection(async () => ({ value: { err: { InstructionError: [0, 'Custom'] } } }));
  await assert.rejects(send(c, payer, transfer), (e) => {
    assert.match(e.message, /landed but failed/);
    assert.equal(e.signature, 'landed-signature');
    return true;
  });
});

test('send: a lost confirmation says the transaction may still land', async () => {
  const c = fakeConnection(async () => { throw new Error('block height exceeded'); });
  await assert.rejects(send(c, payer, transfer), (e) => {
    assert.equal(e.unconfirmed, true);
    assert.equal(e.signature, 'landed-signature');
    assert.match(e.message, /may still land/);
    return true;
  });
});

test('send: a failed send call that may have reached the network keeps the signature', async () => {
  const c = { ...fakeConnection(), sendRawTransaction: async () => { throw new Error('socket hang up'); } };
  await assert.rejects(send(c, payer, transfer), (e) => {
    assert.equal(e.unconfirmed, true);
    assert.ok(e.signature.length > 40);
    assert.match(e.message, /may still land/);
    return true;
  });
});

test('send: an RPC refusal says nothing was sent', async () => {
  const refusal = new SendTransactionError({ action: 'send', signature: '', transactionMessage: 'Blockhash not found' });
  const c = { ...fakeConnection(), sendRawTransaction: async () => { throw refusal; } };
  await assert.rejects(send(c, payer, transfer), (e) => {
    assert.equal(e.signature, undefined);
    assert.equal(e.unconfirmed, undefined);
    assert.match(e.message, /was not sent/);
    return true;
  });
});

test('send: a clean confirmation returns the signature', async () => {
  const c = fakeConnection(async () => ({ value: { err: null } }));
  assert.equal(await send(c, payer, transfer), 'landed-signature');
});

test('wrapper: owner commands and owner keys never reach the CLI', async () => {
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, 'bin/metboi.mjs'), "console.log(JSON.stringify({ reached: true, owner: process.env.METBOI_OWNER_KEY ?? null, args: process.argv.slice(2) }));\n");
  const wrap = (...args) => run('sh', ['skills/metboi-agentic/scripts/metboi.sh', ...args], { env: { PATH: process.env.PATH, METBOI_HOME: home, METBOI_OWNER_KEY: '/secret/owner.json' } }).catch((e) => e);
  for (const command of ['init', 'policy', 'pause', 'resume', 'set-agent', 'withdraw-sol', 'withdraw-token', 'owner-scan', 'owner-dlmm-close', 'owner-damm-close', 'owner-limit-cancel']) {
    const out = await wrap(command);
    assert.equal(out.code, 3, command);
    assert.ok(!out.stdout.includes('reached'));
  }
  for (const flag of [['--owner-key', '/k.json'], ['--owner-key=/k.json']]) {
    const out = await wrap('status', ...flag);
    assert.equal(out.code, 3);
    assert.ok(!out.stdout.includes('reached'));
  }
  const fine = JSON.parse((await wrap('status')).stdout);
  assert.equal(fine.reached, true);
  assert.equal(fine.owner, null, 'the owner key must be removed from the environment');
});
