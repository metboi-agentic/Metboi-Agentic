// End-to-end tests against the real DLMM program and real SOL/USDC pool state on a local fork.
// Attack tests act as a fully compromised agent: it holds its key and crafts any instruction it likes.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, LAMPORTS_PER_SOL, ComputeBudgetProgram } from '@solana/web3.js';
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction,
  createTransferInstruction, getAssociatedTokenAddressSync, getAccount,
} from '@solana/spl-token';
import BN from 'bn.js';
import { ACTIONS, PROGRAM_ID, RULES, fetchVault, ownerIx, send, simulate, vaultPda, walletPda, wrapExecute } from '../sdk/index.mjs';
import { buildClosePosition, buildOpenPosition, buildSwap, loadPool, walletAta } from '../sdk/dlmm.mjs';
import { SOL_USDC_POOL, startFork } from './fork.mjs';
import { innerDisc, redirect } from './helpers.mjs';

const { IDL: DLMM_IDL } = createRequire(import.meta.url)('@meteora-ag/dlmm');
const DLMM_ID = new PublicKey(DLMM_IDL.address);
const SOL = LAMPORTS_PER_SOL;
const NEXT_SLOT_MS = 1200;
const owner = Keypair.generate();
const agent = Keypair.generate();
const attacker = Keypair.generate();
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

const BASE_POLICY = {
  actions: ACTIONS.ALL,
  lamportTxCap: 0.2 * SOL,
  lamportDailyCap: 1 * SOL,
  pools: [SOL_USDC_POOL],
  budgets: [
    { mint: NATIVE_MINT, txCap: 0.5 * SOL, dailyCap: 3 * SOL },
    { mint: USDC, txCap: 1_000_000_000, dailyCap: 5_000_000_000 },
  ],
};

let fork, connection, pool, vault, wallet, walletSol, walletUsdc, attackerSol, attackerUsdc;

const asOwner = (...ixs) => send(connection, owner, ixs);
const usdc = async () => (await getAccount(connection, walletUsdc)).amount;
const wsol = async () => (await getAccount(connection, walletSol)).amount;

/** Index of a Meteora account inside a wrapped execute instruction. */
const REMAINING = 4;
const lastExecute = (instructions) => [...instructions].reverse().find((i) => i.programId.equals(PROGRAM_ID));
const swapBuild = (amountIn = 0.1 * SOL, swapForY = true) => buildSwap({ pool, vault, agent: agent.publicKey, amountIn, swapForY });

async function expectVaultError(name, instructions, signers = [], payer = agent) {
  const sim = await simulate(connection, payer, instructions, signers);
  assert.equal(sim.ok, false, `expected ${name} but simulation passed`);
  assert.equal(sim.error, name, `expected ${name}, got ${sim.error}: ${sim.logs.slice(-4).join(' | ')}`);
}

const withPolicy = async (policy, fn) => {
  await asOwner(ownerIx.updatePolicy({ owner: owner.publicKey, vault, policy: { ...BASE_POLICY, ...policy } }));
  try { await fn(); } finally { await asOwner(ownerIx.updatePolicy({ owner: owner.publicKey, vault, policy: BASE_POLICY })); }
};

before(async () => {
  fork = await startFork();
  connection = fork.connection;
  for (const k of [owner, agent, attacker]) {
    const sig = await connection.requestAirdrop(k.publicKey, 100 * SOL);
    await connection.confirmTransaction(sig, 'confirmed');
  }
  vault = vaultPda(owner.publicKey, 0n);
  wallet = walletPda(vault);
  walletSol = walletAta(vault, NATIVE_MINT);
  walletUsdc = walletAta(vault, USDC);
  attackerSol = getAssociatedTokenAddressSync(NATIVE_MINT, attacker.publicKey);
  attackerUsdc = getAssociatedTokenAddressSync(USDC, attacker.publicKey);

  await asOwner(
    ownerIx.initialize({ owner: owner.publicKey, id: 0n, agent: agent.publicKey, policy: BASE_POLICY }),
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: wallet, lamports: 1 * SOL }),
    createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, walletSol, wallet, NATIVE_MINT),
    createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, walletUsdc, wallet, USDC),
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: walletSol, lamports: 20 * SOL }),
    createSyncNativeInstruction(walletSol),
  );
  await send(connection, attacker, [
    createAssociatedTokenAccountIdempotentInstruction(attacker.publicKey, attackerSol, attacker.publicKey, NATIVE_MINT),
    createAssociatedTokenAccountIdempotentInstruction(attacker.publicKey, attackerUsdc, attacker.publicKey, USDC),
  ]);
  pool = await loadPool(connection, SOL_USDC_POOL);
});

after(() => fork?.stop());

test('agent swaps wSOL to USDC through the real DLMM program and the spend is metered', async () => {
  const usdcBefore = await usdc();
  const solBefore = await wsol();
  const { instructions } = await swapBuild(0.1 * SOL);
  await send(connection, agent, instructions);
  assert.ok((await usdc()) > usdcBefore, 'USDC should arrive in the vault wallet');
  assert.equal(solBefore - (await wsol()), BigInt(0.1 * SOL));
  const state = await fetchVault(connection, vault);
  assert.equal(state.budgets[0].spent, BigInt(0.1 * SOL));
});

test('attack: swap output sent to an attacker token account', async () => {
  const { instructions } = await swapBuild();
  lastExecute(instructions).keys[REMAINING + 5].pubkey = attackerUsdc;
  await expectVaultError('AccountNotOwnedByWallet', instructions);
});

test('attack: swap input taken from a foreign token account', async () => {
  const { instructions } = await swapBuild();
  lastExecute(instructions).keys[REMAINING + 4].pubkey = attackerSol;
  await expectVaultError('AccountNotOwnedByWallet', instructions);
});

test('attack: host fee routed to the attacker', async () => {
  const { instructions } = await swapBuild();
  const key = lastExecute(instructions).keys[REMAINING + 9];
  key.pubkey = attackerSol;
  key.isWritable = true;
  await expectVaultError('FeeRecipientNotAllowed', instructions);
});

test('attack: pool outside the allowlist', async () => {
  const { instructions } = await swapBuild();
  await withPolicy({ pools: [] }, () => expectVaultError('PoolNotAllowed', instructions));
});

test('attack: direct SPL token transfer through execute', async () => {
  const transfer = createTransferInstruction(walletSol, attackerSol, wallet, 1 * SOL);
  await expectVaultError('InstructionNotAllowed', [wrapExecute({ authority: agent.publicKey, vault, instruction: transfer })]);
});

test('attack: system transfer of wallet lamports through execute', async () => {
  const transfer = SystemProgram.transfer({ fromPubkey: wallet, toPubkey: attacker.publicKey, lamports: 0.5 * SOL });
  await expectVaultError('InstructionNotAllowed', [wrapExecute({ authority: agent.publicKey, vault, instruction: transfer })]);
});

test('attack: Meteora instruction outside the rule table', async () => {
  const ix = DLMM_IDL.instructions.find((i) => i.name === 'fund_reward');
  const instruction = new TransactionInstruction({ programId: DLMM_ID, keys: [], data: Buffer.from(ix.discriminator) });
  await expectVaultError('InstructionNotAllowed', [wrapExecute({ authority: agent.publicKey, vault, instruction })]);
});

test('attack: agent calls owner-only instructions', async () => {
  const self = { owner: agent.publicKey, vault };
  await expectVaultError('Unauthorized', [ownerIx.updatePolicy({ ...self, policy: { ...BASE_POLICY, budgets: [] } })]);
  await expectVaultError('Unauthorized', [ownerIx.setPaused({ ...self, paused: false })]);
  await expectVaultError('Unauthorized', [ownerIx.setAgent({ ...self, agent: attacker.publicKey })]);
  await expectVaultError('Unauthorized', [ownerIx.withdrawSol({ ...self, to: attacker.publicKey, lamports: 1000 })]);
  await expectVaultError('Unauthorized', [ownerIx.withdrawToken({ ...self, mint: NATIVE_MINT, from: walletSol, to: attackerSol, amount: 1000 })]);
});

test('attack: a stranger signs execute', async () => {
  const { instructions } = await swapBuild();
  const wrapped = lastExecute(instructions);
  wrapped.keys[0].pubkey = attacker.publicKey;
  await expectVaultError('Unauthorized', [wrapped], [], attacker);
});

test('limit: spend above the per-transaction cap is refused', async () => {
  const { instructions } = await swapBuild(0.6 * SOL);
  await expectVaultError('TxCapExceeded', instructions);
});

test('limit: rolling daily cap stops repeated small swaps, and a policy update does not refresh it', async () => {
  const spent = (await fetchVault(connection, vault)).budgets[0].spent;
  const cap = spent + BigInt(0.15 * SOL);
  await withPolicy({ budgets: [{ mint: NATIVE_MINT, txCap: 0.1 * SOL, dailyCap: cap }, BASE_POLICY.budgets[1]] }, async () => {
    await send(connection, agent, (await swapBuild(0.1 * SOL)).instructions);
    await new Promise((r) => setTimeout(r, NEXT_SLOT_MS)); // The per-trade cap counts per slot, so this must land in a later one.
    await expectVaultError('DailyCapExceeded', (await swapBuild(0.1 * SOL)).instructions);
    const state = await fetchVault(connection, vault);
    assert.equal(state.budgets[0].spent, spent + BigInt(0.1 * SOL), 'counter survives policy updates');
  });
});

test('limit: a token with no budget cannot be spent', async () => {
  const { instructions } = await swapBuild(1_000_000, false);
  await withPolicy({ budgets: [BASE_POLICY.budgets[0]] }, () => expectVaultError('MintNotAllowed', instructions));
});

test('limit: a disabled action is refused', async () => {
  const { instructions } = await swapBuild();
  await withPolicy({ actions: ACTIONS.ALL & ~ACTIONS.SWAP }, () => expectVaultError('ActionDisabled', instructions));
});

test('kill switch: pause blocks the agent until the owner resumes', async () => {
  const { instructions } = await swapBuild();
  await asOwner(ownerIx.setPaused({ owner: owner.publicKey, vault, paused: true }));
  await expectVaultError('Paused', instructions);
  await asOwner(ownerIx.setPaused({ owner: owner.publicKey, vault, paused: false }));
  assert.equal((await simulate(connection, agent, (await swapBuild()).instructions)).ok, true);
});

test('expiry: an expired agent key is refused', async () => {
  const { instructions } = await swapBuild();
  await asOwner(ownerIx.setAgent({ owner: owner.publicKey, vault, agent: agent.publicKey, agentExpiresAt: 1 }));
  await expectVaultError('AgentExpired', instructions);
  await asOwner(ownerIx.setAgent({ owner: owner.publicKey, vault, agent: agent.publicKey, agentExpiresAt: 0 }));
});

test('setup guard: the owner cannot register itself as the agent', async () => {
  await expectVaultError('AgentIsOwner', [ownerIx.setAgent({ owner: owner.publicKey, vault, agent: owner.publicKey })], [], owner);
});

test('attack: vault liquidity added to a position the attacker owns', async () => {
  const position = Keypair.generate();
  const init = await pool.createEmptyPosition({
    positionPubKey: position.publicKey, minBinId: pool.lbPair.activeId - 5, maxBinId: pool.lbPair.activeId + 5, user: attacker.publicKey,
  });
  await send(connection, attacker, init.instructions.filter((i) => !i.programId.equals(ComputeBudgetProgram.programId)), [position]);
  const { instructions } = await buildOpenPosition({ pool, vault, agent: agent.publicKey, amountX: 0.05 * SOL, amountY: 0 });
  const add = lastExecute(instructions);
  add.keys[REMAINING].pubkey = position.publicKey;
  await expectVaultError('PositionNotOwnedByWallet', [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), add]);
});

test('agent opens a real LP position, then removes liquidity, claims, and closes it', async () => {
  const { instructions, position } = await buildOpenPosition({ pool, vault, agent: agent.publicKey, amountX: 0.05 * SOL, amountY: 5_000_000 });
  const solBefore = await wsol();
  await send(connection, agent, instructions, [position]);
  assert.ok((await wsol()) < solBefore, 'liquidity should leave the wallet');
  const stored = await connection.getAccountInfo(position.publicKey);
  assert.deepEqual(new PublicKey(stored.data.subarray(40, 72)), wallet, 'wallet PDA owns the position');

  // Attacks on the live position.
  await pool.refetchStates();
  const [closeSet] = await buildClosePosition({ pool, vault, agent: agent.publicKey, position: position.publicKey, close: false }).then((sets) => sets);
  const remove = lastExecute(closeSet);
  const redirected = new TransactionInstruction({ programId: remove.programId, data: remove.data, keys: remove.keys.map((k, i) => (i === REMAINING + 3 ? { ...k, pubkey: attackerSol } : k)) });
  await expectVaultError('AccountNotOwnedByWallet', [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), redirected]);

  const sets = await buildClosePosition({ pool, vault, agent: agent.publicKey, position: position.publicKey });
  const claims = [RULES.DLMM.instructions.claim_fee, RULES.DLMM.instructions.claim_fee2];
  const claim = sets.flat().map((i) => ({ i, rule: claims.find((c) => i.programId.equals(PROGRAM_ID) && String(c.disc) === String(innerDisc(i))) })).find((x) => x.rule);
  assert.ok(claim, 'close flow should claim fees');
  for (const [name, target] of [['user_token_x', attackerSol], ['user_token_y', attackerUsdc]]) {
    await expectVaultError('AccountNotOwnedByWallet', [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), redirect(claim.i, claim.rule.accounts.indexOf(name), target)]);
  }
  const before = await wsol();
  for (const set of sets) await send(connection, agent, set);
  assert.ok((await wsol()) > before, 'liquidity should come back to the wallet');
  assert.equal(await connection.getAccountInfo(position.publicKey), null, 'position is closed');
});

test('owner withdraws tokens and SOL, and can act while the agent is paused', async () => {
  const ownerSol = getAssociatedTokenAddressSync(NATIVE_MINT, owner.publicKey);
  await asOwner(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ownerSol, owner.publicKey, NATIVE_MINT));
  await asOwner(ownerIx.setPaused({ owner: owner.publicKey, vault, paused: true }));
  const amount = await wsol();
  await asOwner(ownerIx.withdrawToken({ owner: owner.publicKey, vault, mint: NATIVE_MINT, from: walletSol, to: ownerSol, amount, tokenProgram: TOKEN_PROGRAM_ID }));
  assert.equal(await wsol(), 0n);
  assert.equal((await getAccount(connection, ownerSol)).amount, amount);
  const lamports = await connection.getBalance(wallet);
  const receiver = Keypair.generate().publicKey;
  await asOwner(ownerIx.withdrawSol({ owner: owner.publicKey, vault, to: receiver, lamports }));
  assert.equal(await connection.getBalance(wallet), 0);
  assert.equal(await connection.getBalance(receiver), lamports);
});
