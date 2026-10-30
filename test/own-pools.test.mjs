// Pools created on the fork with the real DLMM and DAMM v2 programs, for cases mainnet does not offer on demand:
// Token-2022 transfer fees, live rewards, and transfer hook mints.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Keypair, LAMPORTS_PER_SOL as SOL, PublicKey, SystemProgram, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID as T22, ExtensionType, createAssociatedTokenAccountIdempotentInstruction as ata,
  createInitializeMint2Instruction, createInitializeTransferFeeConfigInstruction, createInitializeTransferHookInstruction,
  createMintToInstruction, createSyncNativeInstruction, getAccount, getAssociatedTokenAddressSync as addr, getMintLen,
} from '@solana/spl-token';
import BN from 'bn.js';
import { ACTIONS, RULES, adaptInstructions, fetchVault, ownerIx, send, simulate, vaultPda } from '../sdk/index.mjs';
import { buildClaimReward, buildClosePosition, buildOpenPosition, buildSwap, loadPool } from '../sdk/dlmm.mjs';
import { buildDammClaimReward, buildDammClose, buildDammOpen, buildDammSwap, loadDamm } from '../sdk/damm.mjs';
import { startFork } from './fork.mjs';
import { attackerTokenAccount, balance, expectVaultError, findExecute, redirect, setupVault } from './helpers.mjs';

const require = createRequire(import.meta.url);
const dlmmModule = require('@meteora-ag/dlmm');
const DLMM = dlmmModule.default ?? dlmmModule;
const { CpAmm, MIN_SQRT_PRICE, MAX_SQRT_PRICE, getBaseFeeParams, BaseFeeMode, derivePoolAddress } = require('@meteora-ag/cp-amm-sdk');
const dlmmIdl = require('../idl/meteora/dlmm.json');
const MAX = '18446744073709551615';
const DECIMALS = 6;
const WHOLE = 10n ** BigInt(DECIMALS);
const REWARD_SECONDS = 86_400;
const CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });
const FEE_BPS = 100;
const LOCK_CLEAR_MS = 3000;

const owner = Keypair.generate();
const creator = Keypair.generate();
let fork, c, env, feeMint, rewardMint, dammPool, dlmmPool, attackerFee;

const operatorPda = PublicKey.findProgramAddressSync([Buffer.from('operator'), creator.publicKey.toBuffer()], new PublicKey(dlmmIdl.address))[0];

function operatorFixture() {
  const data = Buffer.alloc(8 + 32 + 16 + 16);
  Buffer.from(dlmmIdl.accounts.find((a) => a.name === 'Operator').discriminator).copy(data, 0);
  creator.publicKey.toBuffer().copy(data, 8);
  data.fill(0xff, 40, 56);
  return { pubkey: operatorPda, owner: dlmmIdl.address, data };
}

/** Creates a Token-2022 mint with one extension and fills the given accounts. */
async function createT22Mint(extension, initExtension) {
  const mint = Keypair.generate();
  const space = getMintLen([extension]);
  const lamports = await c.getMinimumBalanceForRentExemption(space);
  await send(c, creator, [
    SystemProgram.createAccount({ fromPubkey: creator.publicKey, newAccountPubkey: mint.publicKey, space, lamports, programId: T22 }),
    initExtension(mint.publicKey),
    createInitializeMint2Instruction(mint.publicKey, DECIMALS, creator.publicKey, null, T22),
  ], [mint]);
  return mint.publicKey;
}

const fund = (mint, tokenOwner, amount, program = T22, allowOffCurve = false) => {
  const account = addr(mint, tokenOwner, allowOffCurve, program);
  return send(c, creator, [ata(creator.publicKey, account, tokenOwner, mint, program), createMintToInstruction(mint, account, creator.publicKey, amount, [], program)]);
};

const policy = () => ({
  actions: ACTIONS.ALL, lamportTxCap: 0.3 * SOL, lamportDailyCap: 2 * SOL, pools: [dammPool, dlmmPool].filter(Boolean),
  budgets: [{ mint: NATIVE_MINT, txCap: 2 * SOL, dailyCap: 10 * SOL }, { mint: feeMint, txCap: MAX, dailyCap: MAX }, { mint: rewardMint, txCap: MAX, dailyCap: MAX }],
});
const syncPolicy = () => send(c, env.owner, [ownerIx.updatePolicy({ owner: env.owner.publicKey, vault: env.vault, policy: policy() })]);
const spent = async (mint) => (await fetchVault(c, env.vault)).budgets.find((b) => b.mint.equals(mint)).spent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  fork = await startFork({ programs: [RULES.DLMM.programId, RULES.DAMM_V2.programId], accounts: [NATIVE_MINT.toBase58()], fixtures: [operatorFixture()] });
  c = fork.connection;
  await c.confirmTransaction(await c.requestAirdrop(creator.publicKey, 100 * SOL), 'confirmed');
  feeMint = await createT22Mint(ExtensionType.TransferFeeConfig, (m) => createInitializeTransferFeeConfigInstruction(m, creator.publicKey, creator.publicKey, FEE_BPS, BigInt(1e15), T22));
  const reward = Keypair.generate();
  await send(c, creator, [
    SystemProgram.createAccount({ fromPubkey: creator.publicKey, newAccountPubkey: reward.publicKey, space: 82, lamports: await c.getMinimumBalanceForRentExemption(82), programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(reward.publicKey, DECIMALS, creator.publicKey, null, TOKEN_PROGRAM_ID),
  ], [reward]);
  rewardMint = reward.publicKey;
  await fund(rewardMint, creator.publicKey, 1_000_000n * WHOLE, TOKEN_PROGRAM_ID);
  await fund(feeMint, creator.publicKey, 1_000_000n * WHOLE);
  const creatorSol = addr(NATIVE_MINT, creator.publicKey);
  await send(c, creator, [ata(creator.publicKey, creatorSol, creator.publicKey, NATIVE_MINT), SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: creatorSol, lamports: 30 * SOL }), createSyncNativeInstruction(creatorSol)]);

  env = await setupVault(c, { owner, policy: { ...policy(), pools: [] } });
  await fund(feeMint, env.wallet, 10_000n * WHOLE, T22, true);
  attackerFee = await attackerTokenAccount(c, env.attacker, feeMint, T22);
});
after(() => fork?.stop());

test('hook mints: DAMM v2 and DLMM both refuse a pool for a transfer hook mint without an admin badge', async () => {
  const hookMint = await createT22Mint(ExtensionType.TransferHook, (m) => createInitializeTransferHookInstruction(m, creator.publicKey, Keypair.generate().publicKey, T22));
  const client = new CpAmm(c);
  const positionNft = Keypair.generate();
  // Built with the program client directly, so the refusal comes from the program and not from an SDK check.
  const params = dammPoolParams(hookMint, positionNft.publicKey);
  const damm = await client.createCustomPool(params).then(({ tx }) => simulate(c, creator, tx.instructions.filter((i) => !i.programId.equals(ComputeBudgetProgram.programId)), [positionNft])).catch((e) => ({ ok: false, thrown: e.message }));
  console.log('hook refusal DAMM v2:', damm.error ?? damm.thrown);
  assert.equal(damm.ok, false, 'DAMM v2 must not accept a hook mint');

  const pair = await DLMM.createCustomizablePermissionlessLbPair2(c, new BN(25), hookMint, NATIVE_MINT, new BN(0), new BN(100), 1, false, creator.publicKey);
  const sim = await simulate(c, creator, pair.instructions);
  console.log('hook refusal DLMM:', sim.error);
  assert.equal(sim.ok, false, 'DLMM must not accept a hook mint');
});

function dammPoolParams(mintA, positionNft) {
  const tokenAAmount = new BN(String(100_000n * WHOLE));
  const tokenBAmount = new BN(10 * SOL);
  const client = new CpAmm(c);
  const { initSqrtPrice, liquidityDelta } = client.preparePoolCreationParams({ tokenAAmount, tokenBAmount, minSqrtPrice: MIN_SQRT_PRICE, maxSqrtPrice: MAX_SQRT_PRICE });
  return {
    payer: creator.publicKey, creator: creator.publicKey, positionNft, tokenAMint: mintA, tokenBMint: NATIVE_MINT, tokenAAmount, tokenBAmount,
    sqrtMinPrice: MIN_SQRT_PRICE, sqrtMaxPrice: MAX_SQRT_PRICE, liquidityDelta, initSqrtPrice,
    poolFees: { baseFee: getBaseFeeParams({ baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear, feeTimeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } }, 9, 1), compoundingFeeBps: 0, padding: 0, dynamicFee: null },
    hasAlphaVault: false, activationType: 1, collectFeeMode: 0, activationPoint: null, tokenAProgram: T22, tokenBProgram: TOKEN_PROGRAM_ID,
  };
}

test('damm Token-2022: swap, LP, reward claim, and close, with transfer fees metered at the gross amount', async () => {
  const client = new CpAmm(c);
  const nft = Keypair.generate();
  const { tx, pool } = await client.createCustomPool(dammPoolParams(feeMint, nft.publicKey));
  await send(c, creator, tx.instructions, [nft]);
  dammPool = pool.toBase58();
  await syncPolicy();

  const init = await client.initializeAndFundReward({
    rewardIndex: 0, rewardDuration: new BN(REWARD_SECONDS), pool, creator: creator.publicKey, payer: creator.publicKey, rewardMint,
    carryForward: true, amount: new BN(String(100_000n * WHOLE)), rewardMintProgram: TOKEN_PROGRAM_ID,
  });
  await send(c, creator, init.instructions);

  const walletFee = addr(feeMint, env.wallet, true, T22);
  const spentBefore = await spent(feeMint);
  const held = await balance(c, walletFee, T22);
  let p = await loadDamm(c, dammPool);
  const amountIn = 100n * WHOLE;
  await send(c, env.agent, (await buildDammSwap({ pool: p, vault: env.vault, agent: env.agent.publicKey, inputMint: feeMint, amountIn, slippageBps: 400 })).instructions);
  assert.equal(held - (await balance(c, walletFee, T22)), amountIn, 'wallet pays the gross amount');
  assert.equal((await spent(feeMint)) - spentBefore, amountIn, 'budget charges the gross amount');

  p = await loadDamm(c, dammPool);
  const open = await buildDammOpen({ pool: p, vault: env.vault, agent: env.agent.publicKey, amount: 1000n * WHOLE, isTokenA: true, slippageBps: 500 });
  await send(c, env.agent, open.instructions, [open.positionNft]);
  await sleep(4000);

  p = await loadDamm(c, dammPool);
  const claim = await buildDammClaimReward({ pool: p, vault: env.vault, agent: env.agent.publicKey, position: open.position, nftAccount: open.nftAccount });
  const claimIx = findExecute(claim.instructions, [RULES.DAMM_V2.instructions.claim_reward.disc]);
  assert.ok(claimIx, 'flow should claim the reward');
  const attackerReward = await attackerTokenAccount(c, env.attacker, rewardMint, TOKEN_PROGRAM_ID);
  await expectVaultError(c, env.agent, 'AccountNotOwnedByWallet', [CU, redirect(claimIx, RULES.DAMM_V2.instructions.claim_reward.accounts.indexOf('user_token_account'), attackerReward)]);
  const SKIP_REWARD_AT = 12 + 9; // After the execute header, and the disc and reward index of claim_reward.
  const skipping = Buffer.from(claimIx.data);
  assert.equal(skipping[SKIP_REWARD_AT], 0, 'the SDK does not skip');
  skipping[SKIP_REWARD_AT] = 1;
  const patched = new TransactionInstruction({ programId: claimIx.programId, keys: claimIx.keys, data: skipping });
  await expectVaultError(c, env.agent, 'ArgumentNotAllowed', claim.instructions.map((i) => (i === claimIx ? patched : i)));
  await send(c, env.agent, claim.instructions);
  const walletReward = addr(rewardMint, env.wallet, true, TOKEN_PROGRAM_ID);
  assert.ok((await balance(c, walletReward)) > 0n, 'reward should arrive in the vault wallet');

  p = await loadDamm(c, dammPool);
  const close = await buildDammClose({ pool: p, vault: env.vault, agent: env.agent.publicKey, position: open.position, nftAccount: open.nftAccount, slippageBps: 500 });
  const before = await balance(c, walletFee, T22);
  await send(c, env.agent, close.instructions);
  assert.ok((await balance(c, walletFee, T22)) > before, 'Token-2022 liquidity returns to the wallet');
  assert.equal(await c.getAccountInfo(open.position), null);
});

test('dlmm Token-2022: open with new bin arrays funded by the agent, swap, close, with redirects refused', async () => {
  const pairTx = await DLMM.createCustomizablePermissionlessLbPair2(c, new BN(25), feeMint, NATIVE_MINT, new BN(-1000), new BN(100), 1, false, creator.publicKey, undefined, false, dlmmModule.ConcreteFunctionType.LiquidityMining);
  await send(c, creator, pairTx.instructions);
  const [pairKey] = dlmmModule.deriveCustomizablePermissionlessLbPair(feeMint, NATIVE_MINT, new PublicKey(dlmmIdl.address));
  dlmmPool = pairKey.toBase58();
  await syncPolicy();

  // The agent goes first, so its range needs bin arrays that do not exist yet.
  let pool = await loadPool(c, dlmmPool);
  const active = (await pool.getActiveBin()).binId;
  const open = await buildOpenPosition({ pool, vault: env.vault, agent: env.agent.publicKey, amountX: 100n * WHOLE, amountY: 0.5 * SOL, binsEachSide: 34, slippageBps: 500 });
  const binArrayDisc = Buffer.from(dlmmIdl.instructions.find((i) => i.name === 'initialize_bin_array').discriminator);
  const inits = open.instructions.filter((i) => i.programId.toBase58() === dlmmIdl.address && i.data.subarray(0, 8).equals(binArrayDisc));
  assert.ok(inits.length > 0, 'this open must create new bin arrays');
  for (const init of inits) assert.ok(init.keys[2].pubkey.equals(env.agent.publicKey) && init.keys[2].isSigner, 'the agent funds new bin arrays');
  const walletFee = addr(feeMint, env.wallet, true, T22);
  const before = await balance(c, walletFee, T22);
  await send(c, env.agent, open.instructions, [open.position]);
  assert.ok((await balance(c, walletFee, T22)) < before, 'Token-2022 liquidity leaves the wallet');

  pool = await loadPool(c, dlmmPool);
  const lpPos = Keypair.generate();
  const lp = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: lpPos.publicKey, user: creator.publicKey, totalXAmount: new BN(String(10_000n * WHOLE)), totalYAmount: new BN(5 * SOL),
    strategy: { minBinId: active - 30, maxBinId: active + 30, strategyType: 0 }, slippage: 5,
  });
  await send(c, creator, lp.instructions, [lpPos]);

  pool = await loadPool(c, dlmmPool);
  const swap = await buildSwap({ pool, vault: env.vault, agent: env.agent.publicKey, amountIn: 10n * WHOLE, swapForY: true, slippageBps: 400 });
  const spentBefore = await spent(feeMint);
  await send(c, env.agent, swap.instructions);
  assert.equal((await spent(feeMint)) - spentBefore, 10n * WHOLE, 'budget charges the gross amount');

  pool = await loadPool(c, dlmmPool);
  const sets = await buildClosePosition({ pool, vault: env.vault, agent: env.agent.publicKey, position: open.position.publicKey });
  const remove = findExecute(sets.flat(), ['remove_liquidity', 'remove_liquidity2', 'remove_liquidity_by_range', 'remove_liquidity_by_range2', 'remove_all_liquidity'].map((n) => RULES.DLMM.instructions[n].disc));
  assert.ok(remove, 'flow should remove liquidity');
  await expectVaultError(c, env.agent, 'AccountNotOwnedByWallet', [CU, redirect(remove, RULES.DLMM.instructions.remove_liquidity2.accounts.indexOf('user_token_x'), attackerFee)]);
  // DLMM can refuse with LiquidityLocked right after pool activation. It clears within seconds, so funds are not trapped.
  await sleep(LOCK_CLEAR_MS);
  const mid = await balance(c, walletFee, T22);
  for (const set of sets) await send(c, env.agent, set);
  assert.ok((await balance(c, walletFee, T22)) > mid, 'Token-2022 liquidity returns to the wallet');
});

test('dlmm reward: a real reward accrues and the claim is locked to the vault wallet', async () => {
  let pool = await loadPool(c, dlmmPool);
  const pid = pool.program.programId;
  const event = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], pid)[0];
  const [rewardVault] = dlmmModule.deriveRewardVault(pool.pubkey, new BN(0), pid);
  const init = await pool.program.methods.initializeReward(new BN(0), new BN(REWARD_SECONDS), creator.publicKey).accountsPartial({
    lbPair: pool.pubkey, rewardVault, rewardMint, tokenBadge: pid, operator: operatorPda, signer: creator.publicKey, payer: creator.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, eventAuthority: event, program: pid,
  }).instruction();
  await send(c, creator, [init]);

  pool = await loadPool(c, dlmmPool);
  const active = (await pool.getActiveBin()).binId;
  const open = await buildOpenPosition({ pool, vault: env.vault, agent: env.agent.publicKey, amountX: 50n * WHOLE, amountY: 0.2 * SOL, binsEachSide: 5, slippageBps: 500 });
  await send(c, env.agent, open.instructions, [open.position]);

  const [binArray] = dlmmModule.deriveBinArray(pool.pubkey, new BN(Math.floor(active / 70)), pid);
  const fundIx = await pool.program.methods.fundReward(new BN(0), new BN(String(100_000n * WHOLE)), true, { slices: [] }).accountsPartial({
    lbPair: pool.pubkey, rewardVault, rewardMint, funderTokenAccount: addr(rewardMint, creator.publicKey), funder: creator.publicKey,
    binArray, tokenProgram: TOKEN_PROGRAM_ID, eventAuthority: event, program: pid,
  }).instruction();
  await send(c, creator, [fundIx]);
  await sleep(4000);

  pool = await loadPool(c, dlmmPool);
  const sets = await buildClaimReward({ pool, vault: env.vault, agent: env.agent.publicKey, position: open.position.publicKey });
  const ruleSet = [RULES.DLMM.instructions.claim_reward, RULES.DLMM.instructions.claim_reward2];
  const claim = findExecute(sets.flat(), ruleSet.map((r) => r.disc));
  assert.ok(claim, 'flow should claim the reward');
  const attackerReward = addr(rewardMint, env.attacker.publicKey);
  await expectVaultError(c, env.agent, 'AccountNotOwnedByWallet', [CU, redirect(claim, indexOfRewardAccount(claim), attackerReward)]);
  const walletReward = addr(rewardMint, env.wallet, true);
  const before = await balance(c, walletReward);
  for (const set of sets) await send(c, env.agent, set);
  assert.ok((await balance(c, walletReward)) > before, 'reward should arrive in the vault wallet');
});

function indexOfRewardAccount(wrapped) {
  const inner = [...wrapped.data.subarray(12, 20)];
  const rule = [RULES.DLMM.instructions.claim_reward, RULES.DLMM.instructions.claim_reward2].find((r) => String(r.disc) === String(inner));
  return rule.accounts.indexOf('user_token_account');
}
