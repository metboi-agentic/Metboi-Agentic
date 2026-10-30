// Finds a DLMM pool with an active reward and a DBC pool with a transfer hook, and merges them into test/pools.json.
// Read-only.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Connection, PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, getMint, getTransferHook } from '@solana/spl-token';
import { mainnetRpc } from '../test/fork.mjs';

const require = createRequire(import.meta.url);
const dlmmIdl = require('../idl/meteora/dlmm.json');
const dbcIdl = require('../idl/meteora/dbc.json');
const connection = new Connection(mainnetRpc(), 'confirmed');
const file = new URL('../test/pools.json', import.meta.url);
const pools = JSON.parse(fs.readFileSync(file));
const now = Math.floor(Date.now() / 1000);

// DLMM: scan the first reward slot of every pair. LbPair fields come from the IDL.
const LB_PAIR_SIZE = 904;
const REWARD_OFFSET = 8 + dlmmSizeBeforeRewards();
function dlmmSizeBeforeRewards() {
  const buf = dlmmIdl.types.find((t) => t.name === 'LbPair').type.fields;
  const size = (t) => {
    if (typeof t === 'string') return { u8: 1, i8: 1, bool: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, pubkey: 32 }[t];
    if (t.array) return size(t.array[0]) * t.array[1];
    const def = dlmmIdl.types.find((x) => x.name === t.defined.name);
    return def.type.fields.reduce((n, f) => n + size(f.type), 0);
  };
  let offset = 0;
  for (const f of buf) { if (f.name === 'reward_infos') return offset; offset += size(f.type); }
  throw new Error('reward_infos not found');
}
const accounts = await connection.getProgramAccounts(new PublicKey(dlmmIdl.address), {
  filters: [{ dataSize: LB_PAIR_SIZE }], dataSlice: { offset: REWARD_OFFSET, length: 144 },
});
const live = accounts.filter(({ account }) => {
  const d = account.data;
  const end = Number(d.readBigUInt64LE(32 * 3 + 8));
  const rate = d.subarray(32 * 3 + 16, 32 * 3 + 32);
  return end > now + 3600 && rate.some((b) => b !== 0);
});
console.log('pairs', accounts.length, 'with live reward', live.length);
const dlmmModule = require('@meteora-ag/dlmm');
const DLMM = dlmmModule.default ?? dlmmModule;
let best = null;
for (const { pubkey } of live.slice(0, 60)) {
  const pool = await DLMM.create(connection, pubkey).catch(() => null);
  if (!pool) continue;
  const y = pool.tokenY.publicKey.toBase58();
  if (y !== NATIVE_MINT.toBase58() || pool.tokenX.owner.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()) continue;
  const reserve = Number((await connection.getTokenAccountBalance(pool.lbPair.reserveY)).value.uiAmount);
  if (!best || reserve > best.solInReserve) best = { pool: pubkey.toBase58(), tokenX: pool.tokenX.publicKey.toBase58(), rewardMint: pool.lbPair.rewardInfos[0].mint.toBase58(), rewardVault: pool.lbPair.rewardInfos[0].vault.toBase58(), solInReserve: reserve };
}
pools.dlmmReward = best;

// DBC: look through recent transfer-hook swaps.
const hookDisc = Buffer.from(dbcIdl.instructions.find((i) => i.name === 'swap2_with_transfer_hook').discriminator).toString('hex');
const bs58 = require('bs58');
const decode = (bs58.default ?? bs58).decode;
const sigs = await connection.getSignaturesForAddress(new PublicKey(dbcIdl.address), { limit: 400 });
pools.dbcHook = null;
for (const { signature, err } of sigs) {
  if (err) continue;
  const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 1 }).catch(() => null);
  if (!tx) continue;
  const all = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)];
  const ix = all.find((i) => i.programId?.toBase58() === dbcIdl.address && i.data && Buffer.from(decode(i.data)).subarray(0, 8).toString('hex') === hookDisc);
  if (!ix) continue;
  const names = dbcIdl.instructions.find((i) => i.name === 'swap2_with_transfer_hook').accounts.map((a) => a.name);
  const base = ix.accounts[names.indexOf('base_mint')];
  const hook = getTransferHook(await getMint(connection, base, 'confirmed', TOKEN_2022_PROGRAM_ID));
  pools.dbcHook = { pool: ix.accounts[names.indexOf('pool')].toBase58(), config: ix.accounts[names.indexOf('config')].toBase58(), baseMint: base.toBase58(), hookProgram: hook?.programId?.toBase58() ?? null };
  break;
}
fs.writeFileSync(file, JSON.stringify(pools, null, 1));
console.log(JSON.stringify({ dlmmReward: pools.dlmmReward, dbcHook: pools.dbcHook }, null, 1));
process.exit(0);
