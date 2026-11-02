// Browser-safe vault client for the console: addresses, instruction encoding, and account decoding.
// test/console.test.mjs checks every builder byte for byte against the SDK and spl-token.
import { Buffer } from 'buffer';
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import IDL from '../idl/metboi_agentic.json' with { type: 'json' };
import RULES from '../sdk/rules.json' with { type: 'json' };

export { RULES };
export const PROGRAM_ID = new PublicKey(IDL.address);
export const WSOL = 'So11111111111111111111111111111111111111112';
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const U64_MAX = (1n << 64n) - 1n;
export const MAX_POOLS = 16;
export const MAX_BUDGETS = 8;
export const ACTION_LIST = [
  { bit: 1, label: 'Swap and limit orders' },
  { bit: 2, label: 'Add liquidity' },
  { bit: 4, label: 'Remove liquidity' },
  { bit: 8, label: 'Claim fees and rewards' },
  { bit: 16, label: 'Open and close positions' },
  { bit: 32, label: 'Launch tokens and create pools' },
];
export const VENUES = { [RULES.DLMM.programId]: 'DLMM', [RULES.DAMM_V2.programId]: 'DAMM v2', [RULES.DBC.programId]: 'DBC' };
const ERRORS = Object.fromEntries(IDL.errors.map((e) => [e.name, e.msg]));
const DISC = Object.fromEntries(IDL.instructions.map((i) => [i.name, Buffer.from(i.discriminator)]));
const VAULT_DISC = Buffer.from(IDL.accounts.find((a) => a.name === 'Vault').discriminator);
export const VAULT_SPACE = 8 + 32 + 32 + 8 + 4 + 8 + 240 + 4 + 32 * MAX_POOLS + 4 + (32 + 240) * MAX_BUDGETS;

const u64le = (value) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
};
const i64le = (value) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(value));
  return b;
};
const u32le = (value) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
};
const key = (value) => new PublicKey(value);
const meta = (pubkey, isSigner = false, isWritable = false) => ({ pubkey: key(pubkey), isSigner, isWritable });
const ix = (name, parts, keys) => new TransactionInstruction({ programId: PROGRAM_ID, keys, data: Buffer.concat([DISC[name], ...parts]) });

export const vaultPda = (owner, id = 0n) => PublicKey.findProgramAddressSync([Buffer.from('vault'), key(owner).toBuffer(), u64le(id)], PROGRAM_ID)[0];
export const walletPda = (vault) => PublicKey.findProgramAddressSync([Buffer.from('wallet'), key(vault).toBuffer()], PROGRAM_ID)[0];
export const ataAddress = (owner, mint, tokenProgram = TOKEN_PROGRAM) =>
  PublicKey.findProgramAddressSync([key(owner).toBuffer(), key(tokenProgram).toBuffer(), key(mint).toBuffer()], ATA_PROGRAM)[0];

/** policy: { actions, lamportTxCap, lamportDailyCap, pools, budgets: [{ mint, txCap, dailyCap }] } */
const encodePolicy = ({ actions, lamportTxCap, lamportDailyCap, pools, budgets }) => Buffer.concat([
  Buffer.from([actions]), u64le(lamportTxCap), u64le(lamportDailyCap),
  u32le(pools.length), ...pools.map((p) => key(p).toBuffer()),
  u32le(budgets.length), ...budgets.flatMap((b) => [key(b.mint).toBuffer(), u64le(b.txCap), u64le(b.dailyCap)]),
]);

export const ownerIx = {
  initialize({ owner, id, agent, agentExpiresAt = 0, policy }) {
    const vault = vaultPda(owner, id);
    return ix('initialize', [u64le(id), key(agent).toBuffer(), i64le(agentExpiresAt), encodePolicy(policy)], [
      meta(owner, true, true), meta(vault, false, true), meta(walletPda(vault)), meta(SystemProgram.programId),
    ]);
  },
  updatePolicy: ({ owner, vault, policy }) => ix('update_policy', [encodePolicy(policy)], [meta(owner, true), meta(vault, false, true)]),
  setAgent: ({ owner, vault, agent, agentExpiresAt = 0 }) => ix('set_agent', [key(agent).toBuffer(), i64le(agentExpiresAt)], [meta(owner, true), meta(vault, false, true)]),
  setPaused: ({ owner, vault, paused }) => ix('set_paused', [Buffer.from([paused ? 1 : 0])], [meta(owner, true), meta(vault, false, true)]),
  withdrawToken: ({ owner, vault, mint, from, to, amount, tokenProgram }) => ix('withdraw_token', [u64le(amount)], [
    meta(owner, true), meta(vault), meta(walletPda(vault)), meta(mint), meta(from, false, true), meta(to, false, true), meta(tokenProgram),
  ]),
  withdrawSol: ({ owner, vault, to, lamports }) => ix('withdraw_sol', [u64le(lamports)], [
    meta(owner, true), meta(vault), meta(walletPda(vault), false, true), meta(to, false, true), meta(SystemProgram.programId),
  ]),
};

export const tokenIx = {
  createAtaIdempotent: ({ payer, owner, mint, tokenProgram = TOKEN_PROGRAM }) => new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [meta(payer, true, true), meta(ataAddress(owner, mint, tokenProgram), false, true), meta(owner), meta(mint), meta(SystemProgram.programId), meta(tokenProgram)],
    data: Buffer.from([1]),
  }),
  syncNative: (account) => new TransactionInstruction({ programId: TOKEN_PROGRAM, keys: [meta(account, false, true)], data: Buffer.from([17]) }),
  transferChecked: ({ from, mint, to, owner, amount, decimals, tokenProgram = TOKEN_PROGRAM }) => new TransactionInstruction({
    programId: tokenProgram,
    keys: [meta(from, false, true), meta(mint), meta(to, false, true), meta(owner, true)],
    data: Buffer.concat([Buffer.from([12]), u64le(amount), Buffer.from([decimals])]),
  }),
};

export const transferSol = (from, to, lamports) => SystemProgram.transfer({ fromPubkey: key(from), toPubkey: key(to), lamports: BigInt(lamports) });
export const budgetIxs = (units) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
];

/** Sums the hourly buckets still inside the 24 hour window, the same way the SDK does. */
export function spentNow(meter, nowSeconds = Date.now() / 1000) {
  const hour = Math.floor(nowSeconds / 3600);
  const last = Number(meter.lastHour);
  const expired = new Set();
  for (let h = last + 1; h <= hour && h <= last + meter.buckets.length; h++) expired.add(h % meter.buckets.length);
  return meter.buckets.reduce((sum, b, index) => (expired.has(index) ? sum : sum + b), 0n);
}

export function decodeVault(data) {
  const b = Buffer.from(data);
  if (!b.subarray(0, 8).equals(VAULT_DISC)) throw new Error('Not a vault account');
  let at = 8;
  const pubkey = () => { at += 32; return new PublicKey(b.subarray(at - 32, at)); };
  const u64 = () => { at += 8; return b.readBigUInt64LE(at - 8); };
  const i64 = () => { at += 8; return b.readBigInt64LE(at - 8); };
  const u8 = () => b[at++];
  const u32 = () => { at += 4; return b.readUInt32LE(at - 4); };
  const meter = () => {
    const txCap = u64(), dailyCap = u64(), slotSpent = u64(), lastSlot = u64(), lastHour = i64();
    return { txCap, dailyCap, slotSpent, lastSlot, lastHour, buckets: Array.from({ length: 25 }, u64) };
  };
  const owner = pubkey(), agent = pubkey(), id = u64();
  at += 2;
  const paused = u8() !== 0, actions = u8(), agentExpiresAt = Number(i64()), lamports = meter();
  const pools = Array.from({ length: u32() }, pubkey);
  const budgets = Array.from({ length: u32() }, () => ({ mint: pubkey(), meter: meter() }));
  return { owner, agent, id, paused, actions, agentExpiresAt, lamports, pools, budgets };
}

/** Reads the venue and token mints from a pool account. The offsets are checked against real pools in the tests. */
export function decodePool(ownerProgram, data) {
  const venue = VENUES[ownerProgram];
  if (!venue) return null;
  const at = (offset) => new PublicKey(Buffer.from(data).subarray(offset, offset + 32)).toBase58();
  if (venue === 'DLMM') return { venue, mints: [at(88), at(120)] };
  if (venue === 'DAMM v2') return { venue, mints: [at(168), at(200)] };
  return { venue, mints: [at(136)] };
}

/** Exact decimal text to raw units, with no floating point. */
export function parseAmount(text, decimals) {
  const value = String(text).trim().replaceAll(',', '');
  if (!/^\d*\.?\d*$/.test(value) || !/\d/.test(value)) throw new Error(`"${text}" is not an amount`);
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error(`"${text}" has more than ${decimals} decimal places`);
  const raw = BigInt(`${whole || '0'}${fraction.padEnd(decimals, '0')}`);
  if (raw > U64_MAX) throw new Error(`"${text}" is too large`);
  return raw;
}

export function formatAmount(raw, decimals, maxFraction = decimals) {
  const text = BigInt(raw).toString().padStart(decimals + 1, '0');
  const whole = text.slice(0, text.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = decimals ? text.slice(-decimals).slice(0, maxFraction).replace(/0+$/, '') : '';
  return fraction ? `${whole}.${fraction}` : whole;
}

const SIM_MESSAGES = [
  [/Error: insufficient funds/i, 'There is not enough of this token.'],
  [/InsufficientFundsForRent|insufficient funds for rent/i, 'That would leave too little SOL in the account. Send more, or withdraw all of it.'],
  [/insufficient (funds|lamports)|prior credit/i, 'There is not enough SOL for this transaction.'],
  [/already in use/i, 'This account already exists.'],
];

/** Turns a failed simulation into a sentence the owner can act on. */
export function explainFailure(err, logs = []) {
  const text = logs.join('\n');
  const named = text.match(/Error Code: (\w+)\./);
  if (named) return ERRORS[named[1]] ?? named[1];
  const joined = `${typeof err === 'string' ? err : JSON.stringify(err)}\n${text}`;
  for (const [pattern, message] of SIM_MESSAGES) if (pattern.test(joined)) return message;
  return `The transaction would fail: ${typeof err === 'string' ? err : JSON.stringify(err)}`;
}

const INSTRUCTION_NAMES = {
  initialize: 'Vault created', update_policy: 'Limits changed', set_agent: 'Agent key changed', withdraw_token: 'Token withdrawn', withdraw_sol: 'SOL withdrawn', owner_execute: 'Owner action',
};
const sameBytes = (a, b) => a.length >= b.length && b.every((v, i) => a[i] === v);

/** Names a confirmed transaction from its accounts and instruction bytes. decode turns base58 into bytes. */
export function labelTransaction(tx, owner, decode) {
  const keys = tx.transaction.message.accountKeys.map(String);
  const ours = tx.transaction.message.instructions.filter((i) => keys[i.programIdIndex] === PROGRAM_ID.toBase58()).map((i) => ({ data: decode(i.data), accounts: i.accounts }));
  let agentCall = false;
  const parts = ours.map(({ data, accounts }) => {
    const name = Object.keys(DISC).find((n) => sameBytes(data, [...DISC[n]]));
    if (name === 'set_paused') return data[8] ? 'Agent paused' : 'Agent resumed';
    if (name !== 'execute') return INSTRUCTION_NAMES[name] ?? 'Vault call';
    agentCall = true;
    const target = keys[accounts[3]];
    const venue = Object.entries(RULES).find(([, table]) => table.programId === target);
    const inner = data.subarray(12);
    const hit = venue && Object.entries(venue[1].instructions).find(([, rule]) => sameBytes(inner, rule.disc));
    return hit ? `${VENUES[target]} ${hit[0].replaceAll('_', ' ')}` : 'Agent action';
  });
  const who = keys[0] === String(owner) ? 'owner' : agentCall ? 'agent' : 'other';
  return { who, what: [...new Set(parts)].join(', ') || 'Transaction', failed: Boolean(tx.meta?.err) };
}
