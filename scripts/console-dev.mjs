// Runs the console against a local fork with a stand-in wallet, so its flows can be exercised without real funds.
// The stand-in signs on this server with a throwaway key. Nothing here can reach mainnet with a transaction.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Keypair, LAMPORTS_PER_SOL as SOL, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { RULES } from '../sdk/index.mjs';
import { LOCAL_RPC, SOL_USDC_POOL, mainnetRpc, poolAccounts, startFork } from '../test/fork.mjs';
import { createRpcHandler } from '../server/rpc-proxy.mjs';

const { damm, dbc } = createRequire(import.meta.url)('../test/pools.json');
const root = new URL('../web/', import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 4971);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
const owner = Keypair.generate();
const fork = await startFork({
  programs: [RULES.DLMM.programId, RULES.DAMM_V2.programId, RULES.DBC.programId],
  accounts: [SOL_USDC_POOL, ...await poolAccounts(mainnetRpc()), damm.pool, dbc.pool].map(String),
});
await fork.connection.confirmTransaction(await fork.connection.requestAirdrop(owner.publicKey, 100 * SOL), 'confirmed');
process.on('SIGTERM', () => { fork.stop(); process.exit(0); });

const SHIM = `(() => {
  const address = ${JSON.stringify(owner.publicKey.toBase58())};
  const publicKey = Uint8Array.from(${JSON.stringify([...owner.publicKey.toBytes()])});
  const account = { address, publicKey, chains: ['solana:mainnet'], features: ['solana:signAndSendTransaction'] };
  window.__sent = [];
  const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
  const wallet = {
    version: '1.0.0', name: 'Test Wallet', icon: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', chains: ['solana:mainnet'], accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => {} },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signAndSendTransaction: async ({ transaction }) => {
        if (window.__reject) throw new Error('User rejected the request.');
        const res = await fetch('/__sign', { method: 'POST', body: b64(transaction) });
        const body = await res.json();
        if (body.error) throw new Error(body.error);
        window.__sent.push(body.signature);
        return [{ signature: Uint8Array.from(body.bytes) }];
      } },
    },
  };
  const hook = ({ register }) => register(wallet);
  window.addEventListener('wallet-standard:app-ready', (e) => hook(e.detail));
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: hook }));
})();`;

const rpc = createRpcHandler({ upstream: LOCAL_RPC, perIp: 100_000, total: 100_000 });
http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/rpc') return rpc(req, res);
  if (pathname === '/__shim.js') {
    res.writeHead(200, { 'Content-Type': TYPES['.js'] });
    return res.end(SHIM);
  }
  if (pathname === '/__sign') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      try {
        const tx = Transaction.from(Buffer.from(body, 'base64'));
        tx.partialSign(owner);
        const signature = await fork.connection.sendRawTransaction(tx.serialize());
        res.end(JSON.stringify({ signature, bytes: [...bs58.decode(signature)] }));
      } catch (e) {
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return undefined;
  }
  const clean = path.extname(pathname) ? pathname : `${pathname}.html`;
  const file = path.normalize(path.join(root, pathname === '/' ? 'index.html' : clean));
  if (!file.startsWith(root) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  if (file.endsWith('console.html')) return res.end(fs.readFileSync(file, 'utf8').replace('<script src="console.bundle', '<script src="/__shim.js"></script><script src="console.bundle'));
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`ready http://localhost:${PORT}/console owner ${owner.publicKey.toBase58()}`));
