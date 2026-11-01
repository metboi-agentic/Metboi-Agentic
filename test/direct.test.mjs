// The site says Meteora's own program pays swap output and removed liquidity to any account when called directly.
// These check that claim on the local fork, with one person's own funds. No vault is involved.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL as SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction as ata, createSyncNativeInstruction, getAccount, getAssociatedTokenAddressSync as atad } from '@solana/spl-token';
import BN from 'bn.js';
import { RULES } from '../sdk/index.mjs';
import { StrategyType, loadPool } from '../sdk/dlmm.mjs';
import { SOL_USDC_POOL, mainnetRpc, poolAccounts, startFork } from './fork.mjs';

const require = createRequire(import.meta.url);
const idl = require('../idl/meteora/dlmm.json');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const user = Keypair.generate();
const other = Keypair.generate();
let fork, c, pool;

const names = (ix) => {
  const disc = String([...ix.data.subarray(0, 8)]);
  const def = idl.instructions.find((i) => String(i.discriminator) === disc);
  return { name: def?.name, accounts: def?.accounts.map((a) => a.name) };
};
const sendAll = (ixs, signers = []) => sendAndConfirmTransaction(c, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...ixs), [user, ...signers], { commitment: 'confirmed' });
const balance = async (account) => (await getAccount(c, account, 'confirmed')).amount;
const toOther = (ix, account, target) => {
  const index = names(ix).accounts.indexOf(account);
  assert.ok(index >= 0, `${names(ix).name} has no ${account}`);
  ix.keys[index] = { ...ix.keys[index], pubkey: target };
};

before(async () => {
  fork = await startFork({ programs: [RULES.DLMM.programId], accounts: [SOL_USDC_POOL, ...await poolAccounts(mainnetRpc())].map(String) });
  c = fork.connection;
  for (const who of [user, other]) await c.confirmTransaction(await c.requestAirdrop(who.publicKey, 20 * SOL), 'confirmed');
  const sol = atad(NATIVE_MINT, user.publicKey);
  await sendAll([
    ata(user.publicKey, sol, user.publicKey, NATIVE_MINT),
    ata(user.publicKey, atad(USDC, user.publicKey), user.publicKey, USDC),
    ata(user.publicKey, atad(USDC, other.publicKey), other.publicKey, USDC),
    ata(user.publicKey, atad(NATIVE_MINT, other.publicKey), other.publicKey, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: sol, lamports: 10 * SOL }),
    createSyncNativeInstruction(sol),
  ]);
  pool = await loadPool(c, SOL_USDC_POOL);
});
after(() => fork?.stop());

test('dlmm direct: a swap pays out to an account the caller names', async () => {
  const arrays = await pool.getBinArrayForSwap(true);
  const inAmount = new BN(0.1 * SOL);
  const quote = pool.swapQuote(inAmount, true, new BN(100), arrays);
  const tx = await pool.swap({ inToken: NATIVE_MINT, outToken: USDC, inAmount, minOutAmount: quote.minOutAmount, lbPair: pool.pubkey, user: user.publicKey, binArraysPubkey: quote.binArraysPubkey });
  const swap = tx.instructions.find((i) => i.programId.toBase58() === RULES.DLMM.programId);
  const target = atad(USDC, other.publicKey);
  toOther(swap, 'user_token_out', target);
  await sendAll(tx.instructions.filter((i) => !i.programId.equals(ComputeBudgetProgram.programId)));
  assert.ok(await balance(target) > 0n);
  assert.equal(await balance(atad(USDC, user.publicKey)), 0n);
});

test('dlmm direct: removed liquidity pays out to an account the caller names', async () => {
  const position = Keypair.generate();
  const active = (await pool.getActiveBin()).binId;
  const open = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey, user: user.publicKey, totalXAmount: new BN(0.5 * SOL), totalYAmount: new BN(0),
    strategy: { minBinId: active + 1, maxBinId: active + 6, strategyType: StrategyType.Spot },
  });
  await sendAll(open.instructions.filter((i) => !i.programId.equals(ComputeBudgetProgram.programId)), [position]);
  const target = atad(NATIVE_MINT, other.publicKey);
  const before = await balance(target);
  const built = await pool.removeLiquidity({ user: user.publicKey, position: position.publicKey, fromBinId: active + 1, toBinId: active + 6, bps: new BN(10_000), shouldClaimAndClose: false });
  const tx = Array.isArray(built) ? built[0] : built;
  const remove = tx.instructions.find((i) => i.programId.toBase58() === RULES.DLMM.programId && /remove_liquidity/.test(names(i).name ?? ''));
  assert.ok(remove, 'the transaction removes liquidity');
  toOther(remove, 'user_token_x', target);
  await sendAll(tx.instructions.filter((i) => !i.programId.equals(ComputeBudgetProgram.programId)));
  assert.ok(await balance(target) > before);
});
