// Client for the Metboi Agentic vault: PDA helpers, owner calls, and the wrapper
// that turns a Meteora SDK instruction into a policy-checked vault call.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { PublicKey, SendTransactionError, SystemProgram, Transaction, ComputeBudgetProgram, TransactionInstruction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import anchor from '@coral-xyz/anchor';
import BN from 'bn.js';

const require = createRequire(import.meta.url);
export const IDL = JSON.parse(fs.readFileSync(new URL('../idl/metboi_agentic.json', import.meta.url)));
export const PROGRAM_ID = new PublicKey(IDL.address);
export const RULES = require('./rules.json');
export const TARGET_IDS = new Set(Object.values(RULES).map((t) => t.programId));
export const ACTIONS = { SWAP: 1, ADD_LIQUIDITY: 2, REMOVE_LIQUIDITY: 4, CLAIM: 8, POSITION: 16, LAUNCH: 32, TRADE_AND_LP: 31, ALL: 63 };

const coder = new anchor.BorshCoder(IDL);

export function vaultPda(owner, id = 0n) {
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(BigInt(id));
  return PublicKey.findProgramAddressSync([Buffer.from('vault'), new PublicKey(owner).toBuffer(), le], PROGRAM_ID)[0];
}

export function walletPda(vault) {
  return PublicKey.findProgramAddressSync([Buffer.from('wallet'), new PublicKey(vault).toBuffer()], PROGRAM_ID)[0];
}

function ix(name, args, keys) {
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: coder.instruction.encode(name, args) });
}

const meta = (pubkey, isSigner = false, isWritable = false) => ({ pubkey: new PublicKey(pubkey), isSigner, isWritable });

/** Normalises a human policy into the on-chain input shape. */
export function policyInput({ actions = ACTIONS.TRADE_AND_LP, lamportTxCap = 0, lamportDailyCap = 0, pools = [], budgets = [] }) {
  return {
    actions,
    lamport_tx_cap: new BN(String(lamportTxCap)),
    lamport_daily_cap: new BN(String(lamportDailyCap)),
    pools: pools.map((p) => new PublicKey(p)),
    budgets: budgets.map((b) => ({ mint: new PublicKey(b.mint), tx_cap: new BN(String(b.txCap)), daily_cap: new BN(String(b.dailyCap)) })),
  };
}

export const ownerIx = {
  initialize({ owner, id = 0n, agent, agentExpiresAt = 0, policy }) {
    const vault = vaultPda(owner, id);
    return ix('initialize', { id: new BN(String(id)), agent: new PublicKey(agent), agent_expires_at: new BN(String(agentExpiresAt)), policy: policyInput(policy) }, [
      meta(owner, true, true), meta(vault, false, true), meta(walletPda(vault)), meta(SystemProgram.programId),
    ]);
  },
  updatePolicy({ owner, vault, policy }) {
    return ix('update_policy', { policy: policyInput(policy) }, [meta(owner, true), meta(vault, false, true)]);
  },
  setAgent({ owner, vault, agent, agentExpiresAt = 0 }) {
    return ix('set_agent', { agent: new PublicKey(agent), agent_expires_at: new BN(String(agentExpiresAt)) }, [meta(owner, true), meta(vault, false, true)]);
  },
  setPaused({ owner, vault, paused }) {
    return ix('set_paused', { paused }, [meta(owner, true), meta(vault, false, true)]);
  },
  /** Runs any instruction as the wallet. Owner only, with no rule table. */
  ownerExecute({ owner, vault, instruction }) {
    const wallet = walletPda(vault);
    return ix('owner_execute', { data: Buffer.from(instruction.data) }, [
      meta(owner, true), meta(vault), meta(wallet, false, true), meta(instruction.programId),
      ...instruction.keys.map((k) => ({ pubkey: k.pubkey, isSigner: k.isSigner && !k.pubkey.equals(wallet), isWritable: k.isWritable })),
    ]);
  },
  /** extras are the accounts a transfer hook mint needs. */
  withdrawToken({ owner, vault, mint, from, to, amount, tokenProgram = TOKEN_PROGRAM_ID, extras = [] }) {
    return ix('withdraw_token', { amount: new BN(String(amount)) }, [
      meta(owner, true), meta(vault), meta(walletPda(vault)), meta(mint), meta(from, false, true), meta(to, false, true), meta(tokenProgram),
      ...extras,
    ]);
  },
  withdrawSol({ owner, vault, to, lamports }) {
    return ix('withdraw_sol', { lamports: new BN(String(lamports)) }, [
      meta(owner, true), meta(vault), meta(walletPda(vault), false, true), meta(to, false, true), meta(SystemProgram.programId),
    ]);
  },
};

/** Wraps one Meteora instruction so it runs through the vault policy. */
export function wrapExecute({ authority, vault, instruction }) {
  const wallet = walletPda(vault);
  const remaining = instruction.keys.map((k) => ({
    pubkey: k.pubkey,
    isSigner: k.isSigner && !k.pubkey.equals(wallet),
    isWritable: k.isWritable,
  }));
  return ix('execute', { data: Buffer.from(instruction.data) }, [
    meta(authority, true), meta(vault, false, true), meta(wallet, false, true), meta(instruction.programId),
    ...remaining,
  ]);
}

const SET_COMPUTE_LIMIT = 2;
const MAX_COMPUTE_UNITS = 1_400_000;
const BIN_ARRAY_INIT_DISC = Buffer.from(createHash('sha256').update('global:initialize_bin_array').digest().subarray(0, 8));
const isBinArrayInit = (ix) => ix.programId.toBase58() === RULES.DLMM.programId && ix.data.subarray(0, 8).equals(BIN_ARRAY_INIT_DISC);

const TOKEN_IDS = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);

/**
 * Converts the instructions a Meteora SDK built for the wallet PDA into an agent-signable list.
 * The agent pays for token account creation. SOL wrapping steps are dropped because the vault
 * trades wSOL the owner deposited. Anything else unknown is refused rather than passed through.
 */
export function adaptInstructions({ authority, vault, instructions }) {
  const out = [];
  for (const instruction of instructions) {
    const pid = instruction.programId.toBase58();
    if (instruction.programId.equals(ComputeBudgetProgram.programId)) {
      // The SDK sized its limit without the vault's checks, so a set limit is replaced with the maximum.
      out.push(instruction.data[0] === SET_COMPUTE_LIMIT ? ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }) : instruction);
    } else if (instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      const keys = instruction.keys.map((k, i) => (i === 0 ? { ...k, pubkey: new PublicKey(authority), isSigner: true, isWritable: true } : { ...k, isSigner: false }));
      out.push(new TransactionInstruction({ programId: instruction.programId, keys, data: instruction.data }));
    } else if (isBinArrayInit(instruction)) {
      const keys = instruction.keys.map((k) => (k.isSigner ? { ...k, pubkey: new PublicKey(authority) } : k));
      out.push(new TransactionInstruction({ programId: instruction.programId, keys, data: instruction.data }));
    } else if (TARGET_IDS.has(pid)) {
      out.push(wrapExecute({ authority, vault, instruction }));
    } else if (instruction.programId.equals(SystemProgram.programId) || TOKEN_IDS.has(pid)) {
      continue; // Wrap and unwrap steps would need a wallet signature outside the vault.
    } else {
      throw new Error(`Refusing unknown program in agent transaction: ${pid}`);
    }
  }
  return out;
}

export async function fetchVault(connection, vault) {
  const info = await connection.getAccountInfo(new PublicKey(vault));
  if (!info) return null;
  const v = coder.accounts.decode('Vault', info.data);
  const meter = (m) => {
    // Sums the hourly buckets still inside the 24 hour window.
    const hour = Math.floor(Date.now() / 1000 / 3600);
    const last = Number(m.last_hour.toString());
    const expired = new Set();
    for (let h = last + 1; h <= hour && h <= last + m.buckets.length; h++) expired.add(h % m.buckets.length);
    const spent = m.buckets.reduce((sum, b, index) => (expired.has(index) ? sum : sum + BigInt(b.toString())), 0n);
    return { txCap: BigInt(m.tx_cap.toString()), dailyCap: BigInt(m.daily_cap.toString()), spent };
  };
  return {
    owner: v.owner, agent: v.agent, id: BigInt(v.id.toString()), paused: v.paused, actions: v.actions,
    agentExpiresAt: Number(v.agent_expires_at.toString()),
    lamports: meter(v.lamports), pools: v.pools,
    budgets: v.budgets.map((b) => ({ mint: b.mint, ...meter(b.meter) })),
  };
}

/** Converts instructions a Meteora SDK built for the wallet into ones the owner signs, with no rule table. */
export function adaptForOwner({ owner, vault, instructions }) {
  const out = [];
  for (const instruction of instructions) {
    const pid = instruction.programId.toBase58();
    if (instruction.programId.equals(ComputeBudgetProgram.programId)) {
      out.push(instruction.data[0] === SET_COMPUTE_LIMIT ? ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }) : instruction);
    } else if (instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      const keys = instruction.keys.map((k, n) => (n === 0 ? { ...k, pubkey: new PublicKey(owner), isSigner: true, isWritable: true } : { ...k, isSigner: false }));
      out.push(new TransactionInstruction({ programId: instruction.programId, keys, data: instruction.data }));
    } else if (TARGET_IDS.has(pid)) {
      out.push(ownerIx.ownerExecute({ owner, vault, instruction }));
    } else if (!instruction.programId.equals(SystemProgram.programId) && !TOKEN_IDS.has(pid)) {
      throw new Error(`Refusing unknown program in owner transaction: ${pid}`);
    }
  }
  return out;
}

/** Decodes a vault error from simulation logs into its name. */
export function vaultErrorName(logs = []) {
  const text = logs.join('\n');
  const match = text.match(/Error Code: (\w+)\./);
  return match ? match[1] : null;
}

export async function simulate(connection, payer, instructions, signers = []) {
  const tx = new Transaction().add(...instructions);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(payer, ...signers);
  const before = await connection.getBalance(payer.publicKey);
  const res = await connection.simulateTransaction(tx, undefined, [payer.publicKey]);
  const after = res.value.accounts?.[0]?.lamports;
  return {
    ok: !res.value.err, err: res.value.err, logs: res.value.logs ?? [], units: res.value.unitsConsumed, error: vaultErrorName(res.value.logs ?? []),
    payerLamportsCost: after === undefined ? undefined : before - after,
  };
}

/** Simulates first and refuses to broadcast a transaction that would fail. */
export async function send(connection, payer, instructions, signers = []) {
  const sim = await simulate(connection, payer, instructions, signers);
  if (!sim.ok) {
    const err = new Error(`Simulation failed: ${sim.error ?? JSON.stringify(sim.err)}`);
    err.vaultError = sim.error;
    err.logs = sim.logs;
    throw err;
  }
  const tx = new Transaction().add(...instructions);
  tx.feePayer = payer.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(payer, ...signers);
  // The signature exists before sending. If the send call itself fails, the transaction may still have reached the network.
  const expected = anchor.utils.bytes.bs58.encode(tx.signature);
  let signature;
  try {
    signature = await connection.sendRawTransaction(tx.serialize());
  } catch (e) {
    if (e instanceof SendTransactionError) throw new Error(`The RPC refused the transaction, so it was not sent: ${e.message}`);
    const err = new Error(`The send call failed, so the transaction may still land. Check ${expected} before retrying: ${e.message}`);
    err.signature = expected;
    err.unconfirmed = true;
    throw err;
  }
  let status;
  try {
    status = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  } catch (e) {
    const err = new Error(`Could not confirm the transaction, so it may still land. Check ${signature} before retrying: ${e.message}`);
    err.signature = signature;
    err.unconfirmed = true;
    throw err;
  }
  if (status.value.err) {
    const err = new Error(`Transaction landed but failed: ${JSON.stringify(status.value.err)}`);
    err.signature = signature;
    throw err;
  }
  return signature;
}
