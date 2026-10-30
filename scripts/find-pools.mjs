// Finds live wSOL DAMM v2 and DBC pools from recent mainnet swaps and writes test/pools.json.
// Read-only. Run it again when a recorded pool has migrated or drained.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Connection, PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { mainnetRpc } from '../test/fork.mjs';

const require = createRequire(import.meta.url);
const { CpAmm } = require('@meteora-ag/cp-amm-sdk');
const { DynamicBondingCurveClient } = require('@meteora-ag/dynamic-bonding-curve-sdk');
const rules = require('../sdk/rules.json');
const connection = new Connection(mainnetRpc(), 'confirmed');
const WSOL = NATIVE_MINT.toBase58();
const SWAP_DISCS = new Set(['swap', 'swap2'].map((n) => Buffer.from(rules.DBC.instructions[n].disc).toString('hex')));
const base58 = require('bs58');
const decode = (base58.default ?? base58).decode;

async function recentPools(programId, poolIndex, wanted = 40) {
  const sigs = await connection.getSignaturesForAddress(new PublicKey(programId), { limit: 150 });
  const seen = new Set();
  for (const { signature, err } of sigs) {
    if (err || seen.size >= wanted) continue;
    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 1 }).catch(() => null);
    if (!tx) continue;
    const all = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)];
    for (const ix of all) {
      if (ix.programId?.toBase58() !== programId || !ix.data) continue;
      if (SWAP_DISCS.has(Buffer.from(decode(ix.data)).subarray(0, 8).toString('hex'))) seen.add(ix.accounts[poolIndex].toBase58());
    }
  }
  return [...seen];
}

const mintProgram = async (mint) => (await connection.getAccountInfo(mint)).owner.toBase58();
const out = {};

const damm = new CpAmm(connection);
for (const address of await recentPools(rules.DAMM_V2.programId, 1)) {
  const s = await damm.fetchPoolState(new PublicKey(address));
  const a = s.tokenAMint.toBase58(), b = s.tokenBMint.toBase58();
  const liquid = (await connection.getTokenAccountBalance(a === WSOL ? s.tokenAVault : s.tokenBVault)).value.uiAmount;
  const other = a === WSOL ? s.tokenBMint : s.tokenAMint;
  if ((a !== WSOL && b !== WSOL) || liquid < 5) continue;
  const program = await mintProgram(other);
  if (program !== TOKEN_PROGRAM_ID.toBase58()) continue;
  out.damm = { pool: address, tokenAMint: a, tokenBMint: b, solInVault: liquid };
  break;
}

const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
const dbcCandidates = [];
for (const address of await recentPools(rules.DBC.programId, 2)) {
  const raw = await dbc.state.getPool(new PublicKey(address));
  const s = raw?.poolState ?? raw;
  if (!s || s.isMigrated) continue;
  const config = await dbc.state.getPoolConfig(s.config);
  if (config.quoteMint.toBase58() !== WSOL) continue;
  dbcCandidates.push({ pool: address, config: s.config.toBase58(), baseMint: s.baseMint.toBase58(), baseProgram: await mintProgram(s.baseMint) });
}
out.dbc = dbcCandidates.find((c) => c.baseProgram === TOKEN_PROGRAM_ID.toBase58()) ?? dbcCandidates[0];
out.dbcToken2022 = dbcCandidates.find((c) => c.baseProgram === TOKEN_2022_PROGRAM_ID.toBase58());
out.foundAt = new Date().toISOString();
fs.writeFileSync(new URL('../test/pools.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1), 'dbc candidates', dbcCandidates.length);
process.exit(0);
