// Requests devnet SOL for a key through each configured devnet RPC. Faucets are rate limited per IP.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Connection, LAMPORTS_PER_SOL as SOL, PublicKey } from '@solana/web3.js';

const target = new PublicKey(process.argv[2]);
const env = fs.readFileSync(path.join(os.homedir(), 'rpc/rpc.devnet.env'), 'utf8');
const urls = [...new Set(env.split('\n').filter((l) => /^RPC_(SEND|READ)=/.test(l)).flatMap((l) => l.split('=').slice(1).join('=').split(',')).map((u) => u.split('#')[0].trim()).filter(Boolean))];
urls.push('https://api.devnet.solana.com');
const AMOUNTS = [2, 1, 0.5];
for (const [i, url] of urls.entries()) {
  const c = new Connection(url, 'confirmed');
  for (const amount of AMOUNTS) {
    try {
      const sig = await c.requestAirdrop(target, amount * SOL);
      await c.confirmTransaction(sig, 'confirmed');
      console.log(`rpc${i} ${amount} SOL ok`);
    } catch (e) {
      console.log(`rpc${i} ${amount} SOL failed: ${String(e.message).replace(/https?:\/\/\S+/g, '<rpc>').slice(0, 70)}`);
    }
  }
}
console.log('balance', (await new Connection(urls[0], 'confirmed').getBalance(target)) / SOL);
process.exit(0);
