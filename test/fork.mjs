// Starts a local validator holding the real DLMM program and real pool state cloned from mainnet.
// Mainnet is only read. Nothing here can reach mainnet with a transaction.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Connection, PublicKey } from '@solana/web3.js';
import { createRequire } from 'node:module';
const dlmmModule = createRequire(import.meta.url)('@meteora-ag/dlmm');

const DLMM = dlmmModule.default ?? dlmmModule;
export const SOL_USDC_POOL = '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6';
const PORT = 18899;
export const LOCAL_RPC = `http://127.0.0.1:${PORT}`;
const root = new URL('..', import.meta.url).pathname;

export function mainnetRpc() {
  if (process.env.MAINNET_RPC) return process.env.MAINNET_RPC;
  const env = fs.readFileSync(path.join(os.homedir(), 'rpc/rpc.mainnet.env'), 'utf8');
  const line = env.split('\n').find((l) => l.startsWith('RPC_SEND='));
  return line.slice('RPC_SEND='.length).split(',')[0].split('#')[0].trim();
}

export async function poolAccounts(url) {
  const connection = new Connection(url, 'confirmed');
  const pool = await DLMM.create(connection, new PublicKey(SOL_USDC_POOL));
  const state = pool.lbPair;
  const arrays = [...await pool.getBinArrayForSwap(true, 6), ...await pool.getBinArrayForSwap(false, 6)];
  const set = new Set([
    SOL_USDC_POOL, state.reserveX.toBase58(), state.reserveY.toBase58(), state.tokenXMint.toBase58(),
    state.tokenYMint.toBase58(), state.oracle.toBase58(), ...arrays.map((a) => a.publicKey.toBase58()),
  ]);
  if (pool.binArrayBitmapExtension) set.add(pool.binArrayBitmapExtension.publicKey.toBase58());
  return [...set];
}

/** Options: extra programs and accounts to clone. Defaults to the DLMM SOL/USDC setup. */
/** Writes injected accounts for the validator. Used only for state the public cannot create, such as a whitelisted operator. */
function writeFixtures(fixtures) {
  const dir = path.join(root, 'test/fixtures');
  fs.mkdirSync(dir, { recursive: true });
  return fixtures.flatMap(({ pubkey, owner, data }) => {
    const file = path.join(dir, `${pubkey}.json`);
    fs.writeFileSync(file, JSON.stringify({
      pubkey: String(pubkey),
      account: { lamports: 1_000_000_000, data: [data.toString('base64'), 'base64'], owner: String(owner), executable: false, rentEpoch: 0, space: data.length },
    }));
    return ['--account', String(pubkey), file];
  });
}

export async function startFork({ programs, accounts: extraAccounts, fixtures = [] } = {}) {
  const url = mainnetRpc();
  const accounts = extraAccounts ?? await poolAccounts(url);
  const clonePrograms = programs ?? ['LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'];
  const slot = await new Connection(url, 'confirmed').getSlot();
  const ledger = path.join(root, 'test/.ledger');
  fs.rmSync(ledger, { recursive: true, force: true });
  const args = [
    '--reset', '--quiet', '--ledger', ledger, '--rpc-port', String(PORT), '--faucet-port', '19900', '--dynamic-port-range', '19910-19950',
    '--url', url,
    '--warp-slot', String(slot),
    ...clonePrograms.flatMap((p) => ['--clone-upgradeable-program', p]),
    '--bpf-program', 'keys/program.json', 'target/deploy/metboi_agentic.so',
    ...accounts.flatMap((a) => ['--maybe-clone', a]),
    ...writeFixtures(fixtures),
  ];
  const child = spawn('solana-test-validator', args, { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const connection = new Connection(LOCAL_RPC, 'confirmed');
  for (let i = 0; i < 180; i++) {
    if (child.exitCode !== null) throw new Error(`Validator exited: ${stderr.slice(-400).replaceAll(url, '<rpc>')}`);
    try {
      if ((await connection.getSlot()) > slot) {
        const pool = await connection.getAccountInfo(new PublicKey(accounts[0]));
        if (!pool) throw new Error('Pool was not cloned');
        return { connection, stop: () => child.kill('SIGKILL') };
      }
    } catch (e) {
      if (e.message === 'Pool was not cloned') throw e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  child.kill('SIGKILL');
  throw new Error("Validator did not start");
}
