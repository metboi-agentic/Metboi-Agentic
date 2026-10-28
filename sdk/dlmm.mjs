// DLMM actions for the vault wallet. The Meteora SDK builds them, and the vault wrapper adapts them.
import { Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { createRequire } from 'node:module';
const dlmmModule = createRequire(import.meta.url)('@meteora-ag/dlmm');
import BN from 'bn.js';
import { adaptInstructions, walletPda } from './index.mjs';

const DLMM = dlmmModule.default ?? dlmmModule;
export const StrategyType = dlmmModule.StrategyType ?? DLMM.StrategyType;
const { ResizeSide, ConcreteFunctionType } = dlmmModule;

export const loadPool = (connection, pool) => DLMM.create(connection, new PublicKey(pool));

/** Quotes a swap. The slippage floor is computed here, and min_out is set from it. */
export async function quoteSwap({ pool, amountIn, swapForY, slippageBps = 100 }) {
  const binArrays = await pool.getBinArrayForSwap(swapForY);
  const quote = pool.swapQuote(new BN(String(amountIn)), swapForY, new BN(slippageBps), binArrays);
  return { quote, inToken: swapForY ? pool.tokenX.publicKey : pool.tokenY.publicKey, outToken: swapForY ? pool.tokenY.publicKey : pool.tokenX.publicKey };
}

export async function buildSwap({ pool, vault, agent, amountIn, swapForY, slippageBps = 100 }) {
  const wallet = walletPda(vault);
  const { quote, inToken, outToken } = await quoteSwap({ pool, amountIn, swapForY, slippageBps });
  const tx = await pool.swap({
    inToken, outToken, inAmount: new BN(String(amountIn)), minOutAmount: quote.minOutAmount,
    lbPair: pool.pubkey, user: wallet, binArraysPubkey: quote.binArraysPubkey,
  });
  return { instructions: adaptInstructions({ authority: agent, vault, instructions: tx.instructions }), quote, inToken, outToken };
}

const STRATEGIES = { spot: StrategyType.Spot, curve: StrategyType.Curve, bidask: StrategyType.BidAsk };
const SIDES = { lower: ResizeSide.Lower, upper: ResizeSide.Upper };
const BINS_PER_TX_POSITION = 70;
export const MAX_POSITION_BINS = 1400;

const strategyOf = (name = 'spot') => {
  if (!(name in STRATEGIES)) throw new Error(`Strategy must be one of ${Object.keys(STRATEGIES).join(', ')}`);
  return STRATEGIES[name];
};

/** Resolves a bin range from explicit bins, from prices in token Y per token X, or from a width around the active bin. */
export async function resolveRange(pool, { minBin, maxBin, minPrice, maxPrice, binsEachSide = 10 }) {
  if ((minBin === undefined) !== (maxBin === undefined)) throw new Error('Give both a minimum and a maximum bin');
  if ((minPrice === undefined) !== (maxPrice === undefined)) throw new Error('Give both a minimum and a maximum price');
  let lower, upper;
  if (minBin !== undefined && maxBin !== undefined) {
    [lower, upper] = [Number(minBin), Number(maxBin)];
  } else if (minPrice !== undefined && maxPrice !== undefined) {
    lower = pool.getBinIdFromPrice(Number(pool.toPricePerLamport(Number(minPrice))), false);
    upper = pool.getBinIdFromPrice(Number(pool.toPricePerLamport(Number(maxPrice))), true);
  } else {
    const active = (await pool.getActiveBin()).binId;
    [lower, upper] = [active - Number(binsEachSide), active + Number(binsEachSide)];
  }
  if (!Number.isInteger(lower) || !Number.isInteger(upper) || lower > upper) throw new Error('Invalid bin range');
  if (upper - lower + 1 > MAX_POSITION_BINS) throw new Error(`A position can span at most ${MAX_POSITION_BINS} bins`);
  return { lower, upper };
}

/**
 * Opens a position over any range with any strategy. Up to 70 bins fit one transaction.
 * Wider ranges return further transactions in `more`, sent in order.
 */
export async function buildOpenPosition({ pool, vault, agent, amountX, amountY, minBin, maxBin, minPrice, maxPrice, binsEachSide = 10, strategy = 'spot', slippageBps = 100 }) {
  const wallet = walletPda(vault);
  const position = Keypair.generate();
  const { lower, upper } = await resolveRange(pool, { minBin, maxBin, minPrice, maxPrice, binsEachSide });
  const adapt = (tx) => adaptInstructions({ authority: agent, vault, instructions: tx.instructions });
  const params = {
    positionPubKey: position.publicKey, user: wallet, totalXAmount: new BN(String(amountX)), totalYAmount: new BN(String(amountY)),
    strategy: { minBinId: lower, maxBinId: upper, strategyType: strategyOf(strategy) }, slippage: slippageBps / 100,
  };
  if (upper - lower + 1 <= BINS_PER_TX_POSITION) {
    const tx = await pool.initializePositionAndAddLiquidityByStrategy(params);
    return { instructions: adapt(tx), position, lower, upper, more: [] };
  }
  const init = await pool.createExtendedEmptyPosition(lower, upper, position.publicKey, wallet);
  // The chunk builder reads the position, so the caller asks for the adds once the position exists.
  return {
    instructions: adapt(init), position, lower, upper,
    addAfterInit: async () => (await pool.addLiquidityByStrategyChunkable(params)).map(adapt),
  };
}

export async function buildAddLiquidity({ pool, vault, agent, position, amountX, amountY, strategy = 'spot', slippageBps = 100 }) {
  const wallet = walletPda(vault);
  const { positionData } = await pool.getPosition(new PublicKey(position));
  const tx = await pool.addLiquidityByStrategy({
    positionPubKey: new PublicKey(position), user: wallet, totalXAmount: new BN(String(amountX)), totalYAmount: new BN(String(amountY)),
    strategy: { minBinId: positionData.lowerBinId, maxBinId: positionData.upperBinId, strategyType: strategyOf(strategy) }, slippage: slippageBps / 100,
  });
  return adaptInstructions({ authority: agent, vault, instructions: tx.instructions });
}

/** Removes part of a position, optionally over a sub-range, and leaves it open. */
export async function buildRemoveLiquidity({ pool, vault, agent, position, bps = 10_000, fromBin, toBin }) {
  const wallet = walletPda(vault);
  const { positionData } = await pool.getPosition(new PublicKey(position));
  const txs = await pool.removeLiquidity({
    position: new PublicKey(position), user: wallet,
    fromBinId: fromBin === undefined ? positionData.lowerBinId : Number(fromBin), toBinId: toBin === undefined ? positionData.upperBinId : Number(toBin),
    bps: new BN(bps), shouldClaimAndClose: false,
  });
  return (Array.isArray(txs) ? txs : [txs]).map((tx) => adaptInstructions({ authority: agent, vault, instructions: tx.instructions }));
}

export async function buildClaimFees({ pool, vault, agent, position }) {
  const data = await pool.getPosition(new PublicKey(position));
  const txs = await pool.claimSwapFee({ owner: walletPda(vault), position: data });
  return (Array.isArray(txs) ? txs : [txs]).filter(Boolean).map((tx) => adaptInstructions({ authority: agent, vault, instructions: tx.instructions }));
}

/** Widens a position toward the lower or upper side. The agent key funds the extra rent. */
export async function buildResize({ pool, vault, agent, position, side, bins, grow }) {
  if (!(side in SIDES)) throw new Error('Side must be lower or upper');
  const key = new PublicKey(position);
  const txs = grow
    ? await pool.increasePositionLength(key, SIDES[side], new BN(bins), new PublicKey(agent))
    : await pool.decreasePositionLength(key, SIDES[side], new BN(bins));
  return txs.map((tx) => adaptInstructions({ authority: agent, vault, instructions: tx.instructions }));
}

/**
 * Creates a pool through the vault. DLMM requires the creator to hold the token, so the vault wallet is the creator.
 * It pays rent, metered as SOL spend. Needs the LAUNCH action, and the owner must list the pool before the agent can use it.
 */
export async function buildCreatePool({ connection, vault, agent, mintX, mintY, binStep, feeBps, price, limitOrders = false }) {
  const [x, y] = [new PublicKey(mintX), new PublicKey(mintY)];
  const [ax, ay] = await connection.getMultipleAccountsInfo([x, y]);
  const decimals = (info) => info.data[44];
  const perLamport = Number(price) * 10 ** (decimals(ay) - decimals(ax));
  const activeId = DLMM.getBinIdFromPrice(perLamport, Number(binStep), true);
  const type = limitOrders ? ConcreteFunctionType.LimitOrder : ConcreteFunctionType.LiquidityMining;
  const tx = await DLMM.createCustomizablePermissionlessLbPair2(connection, new BN(binStep), x, y, new BN(activeId), new BN(feeBps), 1, false, walletPda(vault), undefined, false, type);
  const [pool] = dlmmModule.deriveCustomizablePermissionlessLbPair(x, y, new PublicKey(dlmmModule.LBCLMM_PROGRAM_IDS['mainnet-beta']));
  return { instructions: adaptInstructions({ authority: agent, vault, instructions: tx.instructions }), pool, activeId };
}

/** Places a limit order in explicit bins. Only works on pools created with limit orders enabled. */
export async function buildLimitPlace({ pool, vault, agent, side, bins }) {
  if (side !== 'ask' && side !== 'bid') throw new Error('Side must be ask or bid');
  const wallet = walletPda(vault);
  const order = Keypair.generate();
  const tx = await pool.placeLimitOrder({
    owner: wallet, payer: new PublicKey(agent), sender: wallet, limitOrder: order.publicKey,
    params: { isAskSide: side === 'ask', relativeBin: null, bins: bins.map(({ id, amount }) => ({ id: Number(id), amount: new BN(String(amount)) })) },
  });
  return { instructions: adaptInstructions({ authority: agent, vault, instructions: tx.instructions }), order };
}

export async function buildLimitCancel({ pool, vault, agent, order, binIds }) {
  const wallet = walletPda(vault);
  const tx = await pool.cancelLimitOrder({ limitOrderPubkey: new PublicKey(order), owner: wallet, rentReceiver: wallet, binIds: binIds.map(Number) });
  return adaptInstructions({ authority: agent, vault, instructions: tx.instructions });
}

/** Removes all liquidity, claims fees, and optionally closes the position. */
export async function buildClosePosition({ pool, vault, agent, position, bps = 10_000, close = true }) {
  const wallet = walletPda(vault);
  const data = await pool.getPosition(new PublicKey(position));
  const holdsNothing = (data.positionData.positionBinData ?? []).every((bin) => String(bin.positionLiquidity) === '0') && data.positionData.feeX.isZero() && data.positionData.feeY.isZero();
  if (close && holdsNothing) {
    const tx = await pool.closePosition({ owner: wallet, position: data });
    return [adaptInstructions({ authority: agent, vault, instructions: tx.instructions })];
  }
  const txs = await pool.removeLiquidity({
    position: new PublicKey(position), user: wallet,
    fromBinId: data.positionData.lowerBinId, toBinId: data.positionData.upperBinId,
    bps: new BN(bps), shouldClaimAndClose: close,
  });
  return (Array.isArray(txs) ? txs : [txs]).map((tx) => adaptInstructions({ authority: agent, vault, instructions: tx.instructions }));
}

export async function buildClaimReward({ pool, vault, agent, position }) {
  const data = await pool.getPosition(new PublicKey(position));
  const txs = await pool.claimLMReward({ owner: walletPda(vault), position: data });
  return (Array.isArray(txs) ? txs : [txs]).map((tx) => adaptInstructions({ authority: agent, vault, instructions: tx.instructions }));
}

export const walletAta = (vault, mint, tokenProgram) => getAssociatedTokenAddressSync(new PublicKey(mint), walletPda(vault), true, tokenProgram);
