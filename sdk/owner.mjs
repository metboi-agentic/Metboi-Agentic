// Emergency tools for the owner: find everything the vault wallet holds and exit it, without relying on the agent rule table.
import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { RULES, adaptForOwner, walletPda } from './index.mjs';
import { loadPool } from './dlmm.mjs';
import { dammNftAccount, loadDamm, withdrawFloors } from './damm.mjs';

const require = createRequire(import.meta.url);
const { CpAmm } = require('@meteora-ag/cp-amm-sdk');
const dlmmIdl = require('../idl/meteora/dlmm.json');
const OWNER_OFFSET = 8 + 32;
const disc = (name) => Buffer.from(dlmmIdl.accounts.find((a) => a.name === name).discriminator);

/** Lists every DLMM position, DLMM limit order, and DAMM v2 position the wallet holds, across all pools. */
export async function scanWallet({ connection, vault }) {
  const wallet = walletPda(vault);
  const dlmm = await connection.getProgramAccounts(new PublicKey(RULES.DLMM.programId), {
    filters: [{ memcmp: { offset: OWNER_OFFSET, bytes: wallet.toBase58() } }],
  });
  const found = { dlmmPositions: [], limitOrders: [], dammPositions: [] };
  for (const { pubkey, account } of dlmm) {
    const head = account.data.subarray(0, 8);
    const pool = new PublicKey(account.data.subarray(8, 40)).toBase58();
    if (head.equals(disc('PositionV2'))) found.dlmmPositions.push({ position: pubkey.toBase58(), pool });
    if (head.equals(disc('LimitOrder'))) found.limitOrders.push({ order: pubkey.toBase58(), pool });
  }
  const damm = await new CpAmm(connection).getPositionsByUser(wallet);
  for (const { position, positionState } of damm) found.dammPositions.push({ position: position.toBase58(), pool: positionState.pool.toBase58() });
  return found;
}

/** Removes all liquidity, claims, and closes a DLMM position as the owner. Returns transaction sets to send in order. */
export async function buildOwnerDlmmClose({ connection, vault, owner, pool, position }) {
  const loaded = await loadPool(connection, pool);
  const wallet = walletPda(vault);
  const data = await loaded.getPosition(new PublicKey(position));
  const empty = (data.positionData.positionBinData ?? []).every((bin) => String(bin.positionLiquidity) === '0') && data.positionData.feeX.isZero() && data.positionData.feeY.isZero();
  const txs = empty
    ? [await loaded.closePosition({ owner: wallet, position: data })]
    : await loaded.removeLiquidity({ position: new PublicKey(position), user: wallet, fromBinId: data.positionData.lowerBinId, toBinId: data.positionData.upperBinId, bps: new BN(10_000), shouldClaimAndClose: true });
  return (Array.isArray(txs) ? txs : [txs]).map((tx) => adaptForOwner({ owner, vault, instructions: tx.instructions }));
}

/** Removes all liquidity, claims, and closes a DAMM v2 position as the owner. */
export async function buildOwnerDammClose({ connection, vault, owner, pool, position, slippageBps = 100 }) {
  const loaded = await loadDamm(connection, pool);
  const key = new PublicKey(position);
  const nftAccount = await dammNftAccount(loaded, key);
  const { client, state } = loaded;
  const slot = await connection.getSlot();
  const time = await connection.getBlockTime(slot);
  const positionState = await client.fetchPositionState(key);
  const floors = withdrawFloors({ client, state, infoA: loaded.infoA, infoB: loaded.infoB, liquidityDelta: positionState.unlockedLiquidity, slippageBps });
  const tx = await client.removeAllLiquidityAndClosePosition({
    owner: walletPda(vault), position: key, positionNftAccount: nftAccount, poolState: state, positionState,
    tokenAAmountThreshold: floors.a, tokenBAmountThreshold: floors.b, vestings: [], currentPoint: new BN(state.activationType === 0 ? slot : time),
  });
  return [adaptForOwner({ owner, vault, instructions: tx.instructions })];
}

/** Cancels one bin of a DLMM limit order as the owner. */
export async function buildOwnerLimitCancel({ connection, vault, owner, pool, order, bin }) {
  const loaded = await loadPool(connection, pool);
  const wallet = walletPda(vault);
  const tx = await loaded.cancelLimitOrder({ limitOrderPubkey: new PublicKey(order), owner: wallet, rentReceiver: wallet, binIds: [Number(bin)] });
  return [adaptForOwner({ owner, vault, instructions: tx.instructions })];
}
