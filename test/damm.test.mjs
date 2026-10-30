// DAMM v2 against the real program and a real pool on the local fork.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Connection, PublicKey, LAMPORTS_PER_SOL as SOL, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import { NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { ACTIONS, RULES, fetchVault, ownerIx, send, simulate, wrapExecute } from '../sdk/index.mjs';
import { buildDammClaim, buildDammClose, buildDammOpen, buildDammSwap, loadDamm } from '../sdk/damm.mjs';
import { mainnetRpc, startFork } from './fork.mjs';
import { attackerTokenAccount, balance, expectVaultError, findExecute, lastExecute, redirect, setupVault } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { damm } = require('./pools.json');
const idl = require('../idl/meteora/damm.json');
const POOL = damm.pool;
const TOKEN = new PublicKey(damm.tokenAMint === NATIVE_MINT.toBase58() ? damm.tokenBMint : damm.tokenAMint);
const accounts = (name) => RULES.DAMM_V2.instructions[name].accounts;
const CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });

let fork, connection, pool, env, walletToken, attackerToken;
const policy = (over = {}) => ({
  actions: ACTIONS.ALL, lamportTxCap: 0.3 * SOL, lamportDailyCap: SOL, pools: [POOL],
  budgets: [{ mint: NATIVE_MINT, txCap: 0.5 * SOL, dailyCap: 5 * SOL }, { mint: TOKEN, txCap: '18446744073709551615', dailyCap: '18446744073709551615' }],
  ...over,
});
const fail = (name, ixs, signers) => expectVaultError(connection, env.agent, name, ixs, signers);
const swapIn = async (amountIn = 0.1 * SOL) => {
  pool = await loadDamm(connection, POOL); // Quotes go stale after every swap.
  return buildDammSwap({ pool, vault: env.vault, agent: env.agent.publicKey, inputMint: NATIVE_MINT, amountIn });
};

before(async () => {
  const source = await loadDamm(new Connection(mainnetRpc(), 'confirmed'), POOL);
  const s = source.state;
  fork = await startFork({
    programs: [RULES.DAMM_V2.programId],
    accounts: [POOL, s.tokenAVault, s.tokenBVault, s.tokenAMint, s.tokenBMint].map(String),
  });
  connection = fork.connection;
  env = await setupVault(connection, { policy: policy() });
  pool = await loadDamm(connection, POOL);
  walletToken = getAssociatedTokenAddressSync(TOKEN, env.wallet, true);
  attackerToken = await attackerTokenAccount(connection, env.attacker, TOKEN);
});
after(() => fork?.stop());

test('agent swaps through the real DAMM v2 program and the spend is metered', async () => {
  const before = await balance(connection, env.walletSol);
  await send(connection, env.agent, (await swapIn(0.2 * SOL)).instructions);
  assert.equal(before - (await balance(connection, env.walletSol)), BigInt(0.2 * SOL));
  assert.ok((await balance(connection, walletToken)) > 0n, 'token should arrive in the vault wallet');
  assert.equal((await fetchVault(connection, env.vault)).budgets[0].spent, BigInt(0.2 * SOL));
});

test('attack: swap output, input, and referral fee redirected', async () => {
  const swap = lastExecute((await swapIn()).instructions);
  const names = accounts('swap');
  await fail('AccountNotOwnedByWallet', [redirect(swap, names.indexOf('output_token_account'), attackerToken)]);
  await fail('AccountNotOwnedByWallet', [redirect(swap, names.indexOf('input_token_account'), env.attackerSol)]);
  await fail('FeeRecipientNotAllowed', [redirect(swap, names.indexOf('referral_token_account'), env.attackerSol)]);
});

test('limit: allowlist and per-transaction cap apply to DAMM v2', async () => {
  const { instructions } = await swapIn();
  const set = (p) => send(connection, env.owner, [ownerIx.updatePolicy({ owner: env.owner.publicKey, vault: env.vault, policy: p })]);
  await set(policy({ pools: [] }));
  await fail('PoolNotAllowed', instructions);
  await set(policy());
  await fail('TxCapExceeded', (await swapIn(0.6 * SOL)).instructions);
});

test('attack: locking or splitting a position is not callable', async () => {
  for (const name of ['permanent_lock_position', 'lock_position', 'lock_inner_position', 'split_position', 'split_position2', 'update_delegate_permission', 'initialize_pool', 'fund_reward']) {
    const ix = idl.instructions.find((i) => i.name === name);
    const instruction = new TransactionInstruction({ programId: new PublicKey(idl.address), keys: [], data: Buffer.from(ix.discriminator) });
    await fail('InstructionNotAllowed', [wrapExecute({ authority: env.agent.publicKey, vault: env.vault, instruction })]);
  }
});

test('agent runs a full position lifecycle, and each redirect on it is refused', async () => {
  const amountA = (await balance(connection, walletToken)) / 10n;
  const isSolA = damm.tokenAMint === NATIVE_MINT.toBase58();
  assert.equal(isSolA, false, 'recorded pool should have SOL as token B');
  pool = await loadDamm(connection, POOL);
  const open = await buildDammOpen({ pool, vault: env.vault, agent: env.agent.publicKey, amount: amountA });
  const solBefore = await balance(connection, env.walletSol);
  await send(connection, env.agent, open.instructions, [open.positionNft]);
  assert.ok((await balance(connection, env.walletSol)) < solBefore, 'liquidity should leave the wallet');

  const nft = await connection.getTokenAccountBalance(open.nftAccount);
  assert.equal(nft.value.amount, '1', 'wallet holds the position NFT');

  const claim = await buildDammClaim({ pool, vault: env.vault, agent: env.agent.publicKey, position: open.position, nftAccount: open.nftAccount });
  const claimIx = lastExecute(claim.instructions);
  const claimNames = accounts('claim_position_fee');
  await fail('AccountNotOwnedByWallet', [redirect(claimIx, claimNames.indexOf('token_a_account'), attackerToken)]);
  await fail('AccountNotOwnedByWallet', [redirect(claimIx, claimNames.indexOf('token_b_account'), env.attackerSol)]);
  await fail('AccountNotOwnedByWallet', [redirect(claimIx, claimNames.indexOf('position_nft_account'), attackerToken)]);
  await send(connection, env.agent, claim.instructions);

  pool = await loadDamm(connection, POOL);
  const close = await buildDammClose({ pool, vault: env.vault, agent: env.agent.publicKey, position: open.position, nftAccount: open.nftAccount });
  const removeIx = findExecute(close.instructions, [RULES.DAMM_V2.instructions.remove_all_liquidity.disc]);
  assert.ok(removeIx, 'close flow should remove liquidity');
  const removeNames = accounts('remove_all_liquidity');
  await fail('AccountNotOwnedByWallet', [CU, redirect(removeIx, removeNames.indexOf('token_a_account'), attackerToken)]);
  await fail('AccountNotOwnedByWallet', [CU, redirect(removeIx, removeNames.indexOf('token_b_account'), env.attackerSol)]);
  const closeIx = findExecute(close.instructions, [RULES.DAMM_V2.instructions.close_position.disc]);
  assert.ok(closeIx, 'close flow should close the position');
  await fail('AccountNotOwnedByWallet', [CU, redirect(closeIx, accounts('close_position').indexOf('rent_receiver'), env.attacker.publicKey)]);

  // The burn exemption must not open a path around the meter.
  const nftIndex = accounts('close_position').indexOf('position_nft_account');
  await fail('NotAPositionNft', [CU, redirect(closeIx, nftIndex, env.walletSol)]);
  const closeWhileLive = await simulate(connection, env.agent, [CU, closeIx]);
  assert.equal(closeWhileLive.ok, false, 'DAMM v2 must refuse to close a position that still holds liquidity');
  assert.equal(closeWhileLive.error, 'PositionIsNotEmpty', closeWhileLive.logs.slice(-3).join(' | '));

  const solMid = await balance(connection, env.walletSol);
  await send(connection, env.agent, close.instructions);
  assert.ok((await balance(connection, env.walletSol)) > solMid, 'liquidity should come back to the wallet');
  assert.equal(await connection.getAccountInfo(open.position), null, 'position is closed');
});
