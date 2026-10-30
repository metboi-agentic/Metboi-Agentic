// Attacks found in review, each run as a fully compromised agent on the local fork.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Keypair, LAMPORTS_PER_SOL as SOL, PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import {
  NATIVE_MINT, TOKEN_2022_PROGRAM_ID as T22, ExtensionType, createAssociatedTokenAccountIdempotentInstruction as ata, createInitializeMint2Instruction,
  createInitializeTransferHookInstruction, createTransferInstruction, getAccount, getAssociatedTokenAddressSync as addr, getMintLen,
} from '@solana/spl-token';
import { ACTIONS, PROGRAM_ID, RULES, fetchVault, ownerIx, send, simulate, wrapExecute } from '../sdk/index.mjs';
import { buildOpenPosition, buildSwap, loadPool } from '../sdk/dlmm.mjs';
import { SOL_USDC_POOL, mainnetRpc, poolAccounts, startFork } from './fork.mjs';
import { expectVaultError, findExecute, redirect, setupVault } from './helpers.mjs';

const db = createRequire(import.meta.url)('@meteora-ag/dynamic-bonding-curve-sdk');
const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
const EXECUTE_HEADER = 12;

let fork, c, env, pool, pid, event;
const eventAuthority = () => PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], pid)[0];
const fail = (name, ixs, signers = []) => expectVaultError(c, env.agent, name, ixs, signers);
const wrap = (instruction) => wrapExecute({ authority: env.agent.publicKey, vault: env.vault, instruction });

before(async () => {
  fork = await startFork({
    programs: [RULES.DLMM.programId, RULES.DBC.programId, METADATA_PROGRAM],
    accounts: [...new Set([SOL_USDC_POOL, NATIVE_MINT.toBase58(), ...(await poolAccounts(mainnetRpc()))])],
  });
  c = fork.connection;
  env = await setupVault(c, { walletLamports: 10 * SOL, wsolLamports: 10 * SOL, policy: {
    actions: ACTIONS.ALL, lamportTxCap: 5 * SOL, lamportDailyCap: 9 * SOL, pools: [SOL_USDC_POOL],
    budgets: [{ mint: NATIVE_MINT, txCap: 0.5 * SOL, dailyCap: 5 * SOL }, { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', txCap: 1e12, dailyCap: 1e13 }],
  } });
  const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  await send(c, env.owner, [ata(env.owner.publicKey, addr(USDC, env.wallet, true), env.wallet, USDC)]);
  pool = await loadPool(c, SOL_USDC_POOL);
  pid = pool.program.programId;
  event = eventAuthority();
});
after(() => fork?.stop());

const initOnWallet = async () => pool.program.methods.initializePosition((await pool.getActiveBin()).binId, 5).accountsPartial({
  payer: env.agent.publicKey, position: env.wallet, lbPair: pool.pubkey, owner: env.wallet, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY, eventAuthority: event, program: pid,
}).instruction();

test('attack: the wallet cannot be made the new position account', async () => {
  await fail('WalletSlotNotAllowed', [wrap(await initOnWallet())]);
  const info = await c.getAccountInfo(env.wallet);
  assert.ok(info.owner.equals(SystemProgram.programId), 'the wallet stays system-owned');
});

test('attack: the wallet cannot be the limit order account', async () => {
  const tx = await pool.placeLimitOrder({
    owner: env.wallet, payer: env.agent.publicKey, sender: env.wallet, limitOrder: env.wallet,
    params: { isAskSide: true, relativeBin: null, bins: [] },
  });
  const ix = tx.instructions.find((i) => i.programId.equals(pid));
  await fail('WalletSlotNotAllowed', [wrap(ix)]);
});

test('attack: the wallet cannot be added as an extra signer account', async () => {
  const { instructions } = await buildSwap({ pool, vault: env.vault, agent: env.agent.publicKey, amountIn: 0.01 * SOL, swapForY: true });
  const swap = findExecute(instructions, [RULES.DLMM.instructions.swap.disc, RULES.DLMM.instructions.swap2.disc]);
  const extra = new TransactionInstruction({ programId: swap.programId, data: swap.data, keys: [...swap.keys, { pubkey: env.wallet, isSigner: false, isWritable: true }] });
  await fail('WalletSlotNotAllowed', [extra]);
});

test('attack: several swaps in one transaction cannot exceed the per-trade cap', async () => {
  const one = (await buildSwap({ pool, vault: env.vault, agent: env.agent.publicKey, amountIn: 0.3 * SOL, swapForY: true })).instructions;
  const swap = findExecute(one, [RULES.DLMM.instructions.swap.disc, RULES.DLMM.instructions.swap2.disc]);
  const setup = one.filter((i) => !i.programId.equals(PROGRAM_ID) && !i.programId.equals(ComputeBudgetProgram.programId));
  assert.equal((await simulate(c, env.agent, [CU, ...setup, swap])).ok, true, 'one swap fits');
  await fail('TxCapExceeded', [CU, ...setup, swap, swap]);
});

function curve(poolCreationFee) {
  return db.buildCurveWithMarketCap({
    token: { tokenType: db.TokenType.SPLToken, tokenBaseDecimal: db.TokenDecimal.SIX, tokenQuoteDecimal: 9, tokenAuthorityOption: db.TokenAuthorityOption.Immutable, totalTokenSupply: 1e9, leftover: 0 },
    fee: { baseFeeParams: { baseFeeMode: db.BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } }, dynamicFeeEnabled: false, collectFeeMode: db.CollectFeeMode.QuoteToken, creatorTradingFeePercentage: 0, poolCreationFee, enableFirstSwapWithMinFee: false },
    migration: { migrationOption: db.MigrationOption.MET_DAMM_V2, migrationFeeOption: db.MigrationFeeOption.FixedBps100, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 100, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: db.ActivationType.Timestamp, initialMarketCap: 30, migrationMarketCap: 400,
  });
}

async function launchOn(feeClaimer, leftover, fee) {
  const { buildDbcLaunch } = await import('../sdk/dbc.mjs');
  const client = new db.DynamicBondingCurveClient(c, 'confirmed');
  const config = Keypair.generate();
  const tx = await client.partner.createConfig({ ...curve(fee), config: config.publicKey, feeClaimer, leftoverReceiver: leftover, quoteMint: NATIVE_MINT, payer: env.attacker.publicKey });
  await send(c, env.attacker, tx.instructions, [config]);
  return buildDbcLaunch({ connection: c, vault: env.vault, agent: env.agent.publicKey, config: config.publicKey, name: 'X', symbol: 'X', uri: 'https://example.com/x.json' });
}

test('attack: a launch config cannot route fees or leftovers elsewhere or charge a creation fee', async () => {
  const attacker = env.attacker.publicKey;
  for (const [claimer, leftover, fee] of [[attacker, env.wallet, 0], [env.wallet, attacker, 0], [env.wallet, env.wallet, 2]]) {
    const built = await launchOn(claimer, leftover, fee);
    await fail('ConfigNotAllowed', built.instructions, [built.baseMint]);
  }
  const clean = await launchOn(env.wallet, env.wallet, 0);
  assert.equal((await simulate(c, env.agent, clean.instructions, [clean.baseMint])).ok, true, 'a config that pays the wallet is accepted');
});

test('attack: an account that is not a DBC config is refused', async () => {
  const built = await launchOn(env.wallet, env.wallet, 0);
  const rule = RULES.DBC.instructions.initialize_virtual_pool_with_spl_token;
  const launch = findExecute(built.instructions, [rule.disc]);
  await fail('ConfigNotAllowed', [CU, redirect(launch, rule.accounts.indexOf('config'), Keypair.generate().publicKey)], [built.baseMint]);
});

test('attack: rebalance_liquidity cannot remove liquidity or refund rent elsewhere', async () => {
  const active = (await pool.getActiveBin()).binId;
  const built = await buildOpenPosition({ pool, vault: env.vault, agent: env.agent.publicKey, amountX: 0.01 * SOL, amountY: 0, minBin: active + 1, maxBin: active + 90 });
  await send(c, env.agent, built.instructions, [built.position]);
  const sets = await built.addAfterInit();
  const rule = RULES.DLMM.instructions.rebalance_liquidity;
  const wrapped = findExecute(sets.flat(), [rule.disc]);
  assert.ok(wrapped, 'wide deposits use rebalance_liquidity');
  const data = Buffer.from(wrapped.data);
  const REMOVES_LEN = 80;
  data[EXECUTE_HEADER + REMOVES_LEN] = 1;
  await fail('RebalanceRemoveNotAllowed', [CU, new TransactionInstruction({ programId: wrapped.programId, keys: wrapped.keys, data })]);
  await fail('AccountNotOwnedByWallet', [CU, redirect(wrapped, rule.accounts.indexOf('rent_payer'), env.agent.publicKey)]);
});

test('layout: rebalance, reward, and config offsets match bytes encoded from the official IDLs', () => {
  const req = createRequire(import.meta.url);
  const anchor = req('@coral-xyz/anchor');
  const BN = req('bn.js');
  const dlmm = req('../idl/meteora/dlmm.json'), damm = req('../idl/meteora/damm.json');
  const params = {
    active_id: 0, max_active_bin_slippage: 0, should_claim_fee: true, should_claim_reward: true,
    min_withdraw_x_amount: new BN(0), max_deposit_x_amount: new BN(0), min_withdraw_y_amount: new BN(0), max_deposit_y_amount: new BN(0),
    shrink_mode: 0, padding: Array(31).fill(0),
    removes: [{ min_bin_id: null, max_bin_id: null, bps: 1 }, { min_bin_id: null, max_bin_id: null, bps: 1 }], adds: [],
  };
  const data = new anchor.BorshCoder(dlmm).instruction.encode('rebalance_liquidity', { params, remaining_accounts_info: { slices: [] } });
  assert.equal(data.readUInt32LE(80), 2, 'the removes length sits at offset 80');
  assert.equal(data[14], 1, 'should_claim_fee sits at offset 14');
  assert.equal(data[15], 1, 'should_claim_reward sits at offset 15');
  const reward = new anchor.BorshCoder(damm).instruction.encode('claim_reward', { reward_index: 0, skip_reward: 1 });
  assert.equal(reward[9], 1, 'skip_reward sits at offset 9');
  const rules = fs.readFileSync(new URL('../programs/metboi-agentic/src/rules.rs', import.meta.url), 'utf8');
  assert.match(rules, /REBALANCE_REMOVES_LEN: usize = 80;/);
  assert.match(rules, /zero_data: &\[14, 15\]/);
  assert.match(rules, /zero_data: &\[9\]/);
  assert.equal(ExtensionType.TransferHook, 14);
});

test('attack: rebalance cannot claim fees or rewards to net against its deposit', async () => {
  const active = (await pool.getActiveBin()).binId;
  const built = await buildOpenPosition({ pool, vault: env.vault, agent: env.agent.publicKey, amountX: 0.01 * SOL, amountY: 0, minBin: active + 1, maxBin: active + 90 });
  await send(c, env.agent, built.instructions, [built.position]);
  const rule = RULES.DLMM.instructions.rebalance_liquidity;
  const wrapped = findExecute((await built.addAfterInit()).flat(), [rule.disc]);
  for (const offset of [14, 15]) {
    const data = Buffer.from(wrapped.data);
    assert.equal(data[EXECUTE_HEADER + offset], 0, 'the SDK add path leaves it off');
    data[EXECUTE_HEADER + offset] = 1;
    await fail('ArgumentNotAllowed', [CU, new TransactionInstruction({ programId: wrapped.programId, keys: wrapped.keys, data })]);
  }
});

test('attack: a limit order must be a new account', async () => {
  const tx = await pool.placeLimitOrder({
    owner: env.wallet, payer: env.agent.publicKey, sender: env.wallet, limitOrder: env.attackerSol,
    params: { isAskSide: true, relativeBin: null, bins: [] },
  });
  await fail('AccountMustBeNew', [wrap(tx.instructions.find((i) => i.programId.equals(pid)))]);
});

test('attack: a mint with a transfer hook is refused', async () => {
  const mint = Keypair.generate();
  const space = getMintLen([ExtensionType.TransferHook]);
  const owner = env.owner;
  await send(c, owner, [
    SystemProgram.createAccount({ fromPubkey: owner.publicKey, newAccountPubkey: mint.publicKey, space, lamports: await c.getMinimumBalanceForRentExemption(space), programId: T22 }),
    createInitializeTransferHookInstruction(mint.publicKey, owner.publicKey, Keypair.generate().publicKey, T22),
    createInitializeMint2Instruction(mint.publicKey, 6, owner.publicKey, null, T22),
  ], [mint]);
  const { instructions } = await buildSwap({ pool, vault: env.vault, agent: env.agent.publicKey, amountIn: 0.01 * SOL, swapForY: true });
  const swap = findExecute(instructions, [RULES.DLMM.instructions.swap.disc, RULES.DLMM.instructions.swap2.disc]);
  await fail('TransferHookNotAllowed', [redirect(swap, RULES.DLMM.instructions.swap2.accounts.indexOf('token_x_mint'), mint.publicKey)]);
});

test('owner: owner_execute runs as the wallet, and only for the owner', async () => {
  const ownerSol = addr(NATIVE_MINT, env.owner.publicKey);
  await send(c, env.owner, [ata(env.owner.publicKey, ownerSol, env.owner.publicKey, NATIVE_MINT)]);
  const instruction = createTransferInstruction(env.walletSol, ownerSol, env.wallet, 1000);
  await expectVaultError(c, env.agent, 'Unauthorized', [ownerIx.ownerExecute({ owner: env.agent.publicKey, vault: env.vault, instruction })]);
  await expectVaultError(c, env.attacker, 'Unauthorized', [ownerIx.ownerExecute({ owner: env.attacker.publicKey, vault: env.vault, instruction })]);
  await send(c, env.owner, [ownerIx.ownerExecute({ owner: env.owner.publicKey, vault: env.vault, instruction })]);
  assert.equal((await getAccount(c, ownerSol)).amount, 1000n);
});

test('owner: even owner_execute cannot corrupt the wallet', async () => {
  const instruction = await initOnWallet();
  const owned = new TransactionInstruction({ programId: instruction.programId, data: instruction.data, keys: instruction.keys.map((k, i) => (i === 0 ? { ...k, pubkey: env.owner.publicKey } : k)) });
  await expectVaultError(c, env.owner, 'WalletCorrupted', [ownerIx.ownerExecute({ owner: env.owner.publicKey, vault: env.vault, instruction: owned })]);
});

test('owner: owner_execute cannot call the vault program itself', async () => {
  const instruction = new TransactionInstruction({ programId: PROGRAM_ID, keys: [], data: Buffer.alloc(8) });
  await expectVaultError(c, env.owner, 'TargetNotAllowed', [ownerIx.ownerExecute({ owner: env.owner.publicKey, vault: env.vault, instruction })]);
});

test('the meter reports what was charged', async () => {
  const before = (await fetchVault(c, env.vault)).budgets[0].spent;
  await send(c, env.agent, (await buildSwap({ pool, vault: env.vault, agent: env.agent.publicKey, amountIn: 0.02 * SOL, swapForY: true })).instructions);
  assert.equal((await fetchVault(c, env.vault)).budgets[0].spent - before, BigInt(0.02 * SOL));
});
