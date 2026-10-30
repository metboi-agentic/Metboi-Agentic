// Shared setup and assertions for fork tests.
import assert from 'node:assert/strict';
import { Keypair, SystemProgram, LAMPORTS_PER_SOL as SOL, TransactionInstruction, PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PROGRAM_ID, ownerIx, send, simulate, vaultPda, walletPda } from '../sdk/index.mjs';

/** Accounts before the target instruction's own list in a wrapped execute. */
export const REMAINING = 4;
const EXECUTE_HEADER = 8 + 4;

export const lastExecute = (instructions) => [...instructions].reverse().find((i) => i.programId.equals(PROGRAM_ID));
export const innerDisc = (wrapped) => [...wrapped.data.subarray(EXECUTE_HEADER, EXECUTE_HEADER + 8)];

export const findExecute = (instructions, discs) => instructions.find((i) => i.programId.equals(PROGRAM_ID) && discs.some((d) => String(d) === String(innerDisc(i))));

/** Copy of a wrapped instruction with one target account replaced. */
export function redirect(wrapped, targetIndex, pubkey) {
  return new TransactionInstruction({
    programId: wrapped.programId, data: wrapped.data,
    keys: wrapped.keys.map((k, i) => (i === REMAINING + targetIndex ? { ...k, pubkey, isWritable: true } : k)),
  });
}

export async function expectVaultError(connection, payer, name, instructions, signers = []) {
  const sim = await simulate(connection, payer, instructions, signers);
  assert.equal(sim.ok, false, `expected ${name} but simulation passed`);
  assert.equal(sim.error, name, `expected ${name}, got ${sim.error}: ${sim.logs.slice(-4).join(' | ')}`);
}

export async function setupVault(connection, { policy, wsolLamports = 20 * SOL, walletLamports = SOL, owner = Keypair.generate() }) {
  const agent = Keypair.generate(), attacker = Keypair.generate();
  for (const k of [owner, agent, attacker]) await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, 100 * SOL), 'confirmed');
  const vault = vaultPda(owner.publicKey, 0n);
  const wallet = walletPda(vault);
  const walletSol = getAssociatedTokenAddressSync(NATIVE_MINT, wallet, true);
  await send(connection, owner, [
    ownerIx.initialize({ owner: owner.publicKey, id: 0n, agent: agent.publicKey, policy }),
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: wallet, lamports: walletLamports }),
    createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, walletSol, wallet, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: walletSol, lamports: wsolLamports }),
    createSyncNativeInstruction(walletSol),
  ]);
  const attackerSol = getAssociatedTokenAddressSync(NATIVE_MINT, attacker.publicKey);
  await send(connection, attacker, [createAssociatedTokenAccountIdempotentInstruction(attacker.publicKey, attackerSol, attacker.publicKey, NATIVE_MINT)]);
  return { owner, agent, attacker, vault, wallet, walletSol, attackerSol };
}

export const balance = async (connection, account, programId) => (await getAccount(connection, account, 'confirmed', programId)).amount;

export async function attackerTokenAccount(connection, attacker, mint, programId) {
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), attacker.publicKey, false, programId);
  await send(connection, attacker, [createAssociatedTokenAccountIdempotentInstruction(attacker.publicKey, ata, attacker.publicKey, new PublicKey(mint), programId)]);
  return ata;
}
