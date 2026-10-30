// Can an outsider prepare a position so vault money added to it becomes theirs?
// Runs against the real DLMM and DAMM v2 programs on the local fork.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Connection, Keypair, LAMPORTS_PER_SOL as SOL, SystemProgram, ComputeBudgetProgram, PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID as T22, AuthorityType, createApproveInstruction, createAssociatedTokenAccountIdempotentInstruction as ata, createSetAuthorityInstruction, createSyncNativeInstruction, getAccount, getAssociatedTokenAddressSync as addr } from '@solana/spl-token';
import anchor from '@coral-xyz/anchor';
import BN from 'bn.js';
import { ACTIONS, RULES, adaptInstructions, send, simulate, vaultPda, walletPda } from '../sdk/index.mjs';
import { StrategyType, loadPool } from '../sdk/dlmm.mjs';
import { buildDammClose, buildDammSwap, loadDamm } from '../sdk/damm.mjs';
import { SOL_USDC_POOL, mainnetRpc, poolAccounts, startFork } from './fork.mjs';
import { setupVault } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { damm } = require('./pools.json');
const dlmmIdl = require('../idl/meteora/dlmm.json');
const { encodeDelegatePermissions, PositionDelegatePermission: P, derivePositionAddress, derivePositionNftAccount } = require('@meteora-ag/cp-amm-sdk');
const TOKEN = new PublicKey(damm.tokenAMint);
const MAX = '18446744073709551615';
const POSITION_LEN = 8120, OPERATOR = 7960, LOCK = 7992, FEE_OWNER = 8001;
const ACTIVE_RANGE = 34;
const CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });

const owner = Keypair.generate();
const outsider = Keypair.generate();
const crafted = { operator: Keypair.generate().publicKey, feeOwner: Keypair.generate().publicKey, lock: Keypair.generate().publicKey, clean: Keypair.generate().publicKey };
let fork, c, env, activeBin;
const coder = new anchor.BorshCoder(dlmmIdl);
const PDISC = Buffer.from(dlmmIdl.accounts.find((a) => a.name === 'PositionV2').discriminator);

function positionData({ lbPair, positionOwner, lower, upper, operator, feeOwner, lock = 0n }) {
  const d = Buffer.alloc(POSITION_LEN);
  PDISC.copy(d, 0);
  lbPair.toBuffer().copy(d, 8);
  positionOwner.toBuffer().copy(d, 40);
  d.writeInt32LE(lower, 7912);
  d.writeInt32LE(upper, 7916);
  if (operator) operator.toBuffer().copy(d, OPERATOR);
  if (lock) d.writeBigUInt64LE(lock, LOCK);
  if (feeOwner) feeOwner.toBuffer().copy(d, FEE_OWNER);
  return d;
}

before(async () => {
  const mainnet = new Connection(mainnetRpc(), 'confirmed');
  const ds = (await loadDamm(mainnet, damm.pool)).state;
  const live = await loadPool(mainnet, SOL_USDC_POOL);
  activeBin = (await live.getActiveBin()).binId;
  const wallet = walletPda(vaultPda(owner.publicKey, 0n));
  const lbPair = new PublicKey(SOL_USDC_POOL);
  const base = { lbPair, positionOwner: wallet, lower: activeBin - ACTIVE_RANGE, upper: activeBin + ACTIVE_RANGE };
  const fixtures = [
    ['operator', { operator: outsider.publicKey }], ['feeOwner', { feeOwner: outsider.publicKey }], ['lock', { lock: 99_999_999_999n }], ['clean', {}],
  ].map(([k, over]) => ({ pubkey: crafted[k], owner: dlmmIdl.address, data: positionData({ ...base, ...over }) }));
  fork = await startFork({
    programs: [RULES.DLMM.programId, RULES.DAMM_V2.programId],
    accounts: [...new Set([SOL_USDC_POOL, ...(await poolAccounts(mainnetRpc())), damm.pool, ds.tokenAVault, ds.tokenBVault, ds.tokenAMint, ds.tokenBMint].map(String))],
    fixtures,
  });
  c = fork.connection;
  env = await setupVault(c, { owner, policy: {
    actions: ACTIONS.ALL, lamportTxCap: 0.3 * SOL, lamportDailyCap: SOL, pools: [SOL_USDC_POOL, damm.pool],
    budgets: [{ mint: NATIVE_MINT, txCap: SOL, dailyCap: 8 * SOL }, { mint: TOKEN, txCap: MAX, dailyCap: MAX }],
  } });
  await c.confirmTransaction(await c.requestAirdrop(outsider.publicKey, 20 * SOL), 'confirmed');
  await send(c, env.attacker, [SystemProgram.transfer({ fromPubkey: env.attacker.publicKey, toPubkey: env.attackerSol, lamports: 3 * SOL }), createSyncNativeInstruction(env.attackerSol)]);
});
after(() => fork?.stop());

test('layout: the vault offsets match the official DLMM position layout', () => {
  const data = positionData({ lbPair: new PublicKey(SOL_USDC_POOL), positionOwner: outsider.publicKey, lower: -3, upper: 3, operator: crafted.operator, feeOwner: crafted.feeOwner, lock: 42n });
  const decoded = coder.accounts.decode('PositionV2', data);
  assert.ok(decoded.operator.equals(crafted.operator));
  assert.ok(decoded.fee_owner.equals(crafted.feeOwner));
  assert.equal(decoded.lock_release_point.toString(), '42');
  assert.ok(decoded.owner.equals(outsider.publicKey));
  assert.equal(decoded.lower_bin_id, -3);
});

test('dlmm: an outsider cannot name itself operator of a position owned by the vault wallet', async () => {
  const pool = await loadPool(c, SOL_USDC_POOL);
  const base = Keypair.generate();
  const le = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
  const pid = pool.program.programId;
  const position = PublicKey.findProgramAddressSync([Buffer.from('position'), pool.pubkey.toBuffer(), base.publicKey.toBuffer(), le(activeBin), le(11)], pid)[0];
  const ix = await pool.program.methods.initializePositionByOperator(activeBin, 11, env.attacker.publicKey, new BN(0)).accountsPartial({
    payer: env.attacker.publicKey, base: base.publicKey, position, lbPair: pool.pubkey, owner: env.wallet, operator: env.attacker.publicKey,
    operatorTokenX: env.attackerSol, ownerTokenX: env.walletSol, systemProgram: SystemProgram.programId,
    eventAuthority: PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], pid)[0], program: pid,
  }).instruction();
  const sim = await simulate(c, env.attacker, [ix], [base]);
  assert.equal(sim.ok, false);
  assert.equal(sim.error, 'UnauthorizedAccess');
});

const addTo = async (position) => {
  const pool = await loadPool(c, SOL_USDC_POOL);
  const add = await pool.addLiquidityByStrategy({
    positionPubKey: position, user: env.wallet, totalXAmount: new BN(0.1 * SOL), totalYAmount: new BN(0),
    strategy: { minBinId: activeBin, maxBinId: activeBin + 8, strategyType: StrategyType.Spot }, slippage: 5,
  });
  return adaptInstructions({ authority: env.agent.publicKey, vault: env.vault, instructions: add.instructions });
};

test('dlmm: the vault refuses to fund a position with a foreign operator, fee owner, or lock', async () => {
  for (const key of ['operator', 'feeOwner', 'lock']) {
    const sim = await simulate(c, env.agent, await addTo(crafted[key]));
    assert.equal(sim.ok, false, `${key} should be refused`);
    assert.equal(sim.error, 'PositionControlledByOther', `${key}: ${sim.logs.slice(-3).join(' | ')}`);
  }
});

test('dlmm: the same crafted position with nothing foreign set gets past the check', async () => {
  const sim = await simulate(c, env.agent, await addTo(crafted.clean));
  assert.notEqual(sim.error, 'PositionControlledByOther', sim.logs.slice(-3).join(' | '));
});

test('damm: a delegate set before handing the NFT over gains nothing, and the agent can still recover the funds', async () => {
  let d = await loadDamm(c, damm.pool);
  const posNft = Keypair.generate();
  const { attacker, agent, vault, wallet } = env;
  await send(c, attacker, (await d.client.createPosition({ owner: attacker.publicKey, payer: attacker.publicKey, pool: d.pool, positionNft: posNft.publicKey })).instructions, [posNft]);
  const position = derivePositionAddress(posNft.publicKey);
  const nft = derivePositionNftAccount(posNft.publicKey);
  const pid = new PublicKey(RULES.DAMM_V2.programId);
  const update = await d.client._program.methods.updateDelegatePermission(encodeDelegatePermissions([P.AddLiquidity, P.RemoveLiquidity, P.ClaimPositionFee])).accountsPartial({
    position, positionNftAccount: nft, owner: attacker.publicKey,
    eventAuthority: PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], pid)[0], program: pid,
  }).instruction();
  await send(c, attacker, [createApproveInstruction(nft, attacker.publicKey, attacker.publicKey, 1, [], T22), update]);
  assert.ok((await getAccount(c, nft, 'confirmed', T22)).delegate.equals(attacker.publicKey));

  await send(c, attacker, [createSetAuthorityInstruction(nft, attacker.publicKey, AuthorityType.AccountOwner, wallet, [], T22)]);
  const handed = await getAccount(c, nft, 'confirmed', T22);
  assert.ok(handed.owner.equals(wallet));
  assert.equal(handed.delegate, null, 'Token-2022 clears the delegate on an owner change');

  await send(c, agent, (await buildDammSwap({ pool: d, vault, agent: agent.publicKey, inputMint: NATIVE_MINT, amountIn: 0.5 * SOL })).instructions);
  d = await loadDamm(c, damm.pool);
  const amount = new BN(String((await getAccount(c, addr(TOKEN, wallet, true))).amount / 2n));
  const quote = d.client.getDepositQuote({ inAmount: amount, isTokenA: true, sqrtPrice: d.state.sqrtPrice, minSqrtPrice: d.state.sqrtMinPrice, maxSqrtPrice: d.state.sqrtMaxPrice });
  const add = await d.client.addLiquidity({
    owner: wallet, position, pool: d.pool, positionNftAccount: nft, liquidityDelta: quote.liquidityDelta,
    maxAmountTokenA: amount.muln(2), maxAmountTokenB: quote.outputAmount.muln(2), tokenAAmountThreshold: amount.muln(2), tokenBAmountThreshold: quote.outputAmount.muln(2),
    tokenAMint: d.state.tokenAMint, tokenBMint: d.state.tokenBMint, tokenAVault: d.state.tokenAVault, tokenBVault: d.state.tokenBVault, tokenAProgram: d.programA, tokenBProgram: d.programB,
  });
  await send(c, agent, adaptInstructions({ authority: agent.publicKey, vault, instructions: add.instructions }));

  d = await loadDamm(c, damm.pool);
  const attackerToken = addr(TOKEN, attacker.publicKey);
  await send(c, attacker, [ata(attacker.publicKey, attackerToken, attacker.publicKey, TOKEN)]);
  const stolen = await d.client.removeAllLiquidity({
    owner: attacker.publicKey, position, positionNftAccount: nft, poolState: d.state, positionState: await d.client.fetchPositionState(position),
    tokenAAmountThreshold: new BN(0), tokenBAmountThreshold: new BN(0), vestings: [], currentPoint: new BN(0), pool: d.pool,
    tokenAMint: d.state.tokenAMint, tokenBMint: d.state.tokenBMint, tokenAVault: d.state.tokenAVault, tokenBVault: d.state.tokenBVault, tokenAProgram: d.programA, tokenBProgram: d.programB,
  });
  const sim = await simulate(c, attacker, [CU, ...stolen.instructions.filter((i) => i.programId.equals(pid))]);
  assert.equal(sim.ok, false, 'the old delegate must not be able to withdraw');
  assert.equal(sim.error, 'InvalidAuthority');

  const solBefore = (await getAccount(c, env.walletSol)).amount;
  const close = await buildDammClose({ pool: d, vault, agent: agent.publicKey, position, nftAccount: nft });
  await send(c, agent, close.instructions);
  assert.ok((await getAccount(c, env.walletSol)).amount > solBefore, 'funds come back to the vault wallet');
});
