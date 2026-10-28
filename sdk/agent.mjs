// Agent-side operations shared by the CLI and the MCP server.
// This layer only ever holds the agent key. Nothing here can change policy or withdraw.
// Every action simulates, and only broadcasts when asked to.
import fs from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAccount } from '@solana/spl-token';
import { ACTIONS, RULES, fetchVault, send, simulate, walletPda } from './index.mjs';
import { resolveRange, buildAddLiquidity, buildClaimFees, buildClaimReward, buildClosePosition, buildCreatePool, buildLimitCancel, buildLimitPlace, buildOpenPosition, buildRemoveLiquidity, buildResize, buildSwap, loadPool, walletAta } from './dlmm.mjs';
import { buildDammAdd, buildDammClaim, buildDammClaimReward, buildDammClose, buildDammCreatePool, buildDammOpen, buildDammRemove, buildDammSwap, dammNftAccount, listDammPositions, loadDamm } from './damm.mjs';
import { buildDbcClaimCreator, buildDbcClaimPartner, buildDbcConfig, buildDbcLaunch, buildDbcSwap, buildDbcWithdrawLeftover, buildDbcWithdrawSurplus, loadDbc } from './dbc.mjs';

export const MAX_SLIPPAGE_BPS = 500;

/** Reads a key file. Errors never repeat the path or contents, in case a key was passed by mistake. */
export function loadKeypair(file) {
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
  } catch {
    throw new Error('Could not read a key from that file. It must be a path to a Solana keypair JSON file.');
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

/** Flags in overrides win over environment variables. */
export function agentFromEnv(overrides = {}) {
  const setting = (key, name) => overrides[key] ?? required(name);
  return new AgentOps({
    connection: new Connection(setting('rpc', 'METBOI_RPC'), 'confirmed'),
    agent: loadKeypair(setting('agentKey', 'METBOI_AGENT_KEY')),
    vault: new PublicKey(setting('vault', 'METBOI_VAULT')),
  });
}

/** Refuses to build on a floor below the one the caller approved, for example from an earlier quote. */
const checkFloor = (floor, minOut) => {
  if (minOut !== undefined && BigInt(floor.toString()) < BigInt(minOut)) {
    throw new Error(`MinOutNotMet: the current floor ${floor} is below the approved ${minOut}. Quote again.`);
  }
};

/** A new account's key is worth keeping once its transaction was sent, even if confirmation was lost. */
const keyIfSent = (result, key) => (result.ok || result.signature ? key : undefined);

const checkSlippage = (bps) => {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_SLIPPAGE_BPS) throw new Error(`Slippage must be 0 to ${MAX_SLIPPAGE_BPS} bps`);
  return bps;
};

/** Makes vault state and quotes JSON-safe. */
export const plain = (value) => JSON.parse(JSON.stringify(value, (_, v) => {
  if (typeof v === 'bigint') return v.toString();
  if (v && typeof v === 'object' && typeof v.toBase58 === 'function') return v.toBase58();
  return v;
}));

export class AgentOps {
  constructor({ connection, agent, vault }) {
    Object.assign(this, { connection, agent, vault: new PublicKey(vault), wallet: walletPda(vault) });
  }

  /** Names the venue of each listed pool from the program that owns it. */
  async #describePools(pools) {
    const infos = await this.connection.getMultipleAccountsInfo(pools);
    const venues = { [RULES.DLMM.programId]: 'dlmm', [RULES.DAMM_V2.programId]: 'damm', [RULES.DBC.programId]: 'dbc' };
    return pools.map((address, i) => ({ address, venue: venues[infos[i]?.owner.toBase58()] ?? 'unknown' }));
  }

  async status() {
    const state = await fetchVault(this.connection, this.vault);
    if (!state) throw new Error('Vault not found');
    const lists = await Promise.all([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) => this.connection.getParsedTokenAccountsByOwner(this.wallet, { programId })));
    const tokens = lists.flatMap((l) => l.value);
    const left = (m) => m.dailyCap - m.spent;
    return plain({
      vault: this.vault, wallet: this.wallet, agent: this.agent.publicKey,
      isActiveAgent: state.agent.equals(this.agent.publicKey), paused: state.paused, agentExpiresAt: state.agentExpiresAt, actions: state.actions,
      lamports: await this.connection.getBalance(this.wallet),
      lamportBudget: { txCap: state.lamports.txCap, remainingToday: left(state.lamports) },
      pools: await this.#describePools(state.pools),
      budgets: state.budgets.map((b) => ({ mint: b.mint, txCap: b.txCap, remainingToday: left(b) })),
      balances: tokens.map((t) => ({ mint: t.account.data.parsed.info.mint, amount: t.account.data.parsed.info.tokenAmount.amount, decimals: t.account.data.parsed.info.tokenAmount.decimals })),
    });
  }

  async poolInfo(address) {
    const pool = await loadPool(this.connection, address);
    const active = await pool.getActiveBin();
    return plain({
      pool: address, tokenX: pool.tokenX.publicKey, tokenY: pool.tokenY.publicKey,
      binStep: pool.lbPair.binStep, activeBin: active.binId, price: pool.fromPricePerLamport(Number(active.price)),
    });
  }

  async quote({ pool, amountIn, swapForY, slippageBps = 100 }) {
    const loaded = await loadPool(this.connection, pool);
    const { quote, inToken, outToken } = await buildSwap({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, amountIn, swapForY, slippageBps: checkSlippage(slippageBps) });
    return plain({ inToken, outToken, amountIn: String(amountIn), expectedOut: quote.outAmount.toString(), minOut: quote.minOutAmount.toString(), priceImpact: quote.priceImpact.toString() });
  }

  /** Simulates, then sends only when broadcast is true. */
  async #run(instructions, signers, broadcast) {
    const sim = await simulate(this.connection, this.agent, instructions, signers);
    if (!sim.ok) return { ok: false, simulated: true, broadcast: false, error: sim.error ?? JSON.stringify(sim.err), logs: sim.logs.slice(-6) };
    const seen = { vault: this.vault.toBase58(), agentLamportsCost: sim.payerLamportsCost };
    if (!broadcast) return { ok: true, simulated: true, broadcast: false, computeUnits: sim.units, ...seen };
    try {
      return { ok: true, simulated: true, broadcast: true, signature: await send(this.connection, this.agent, instructions, signers), ...seen };
    } catch (e) {
      return { ok: false, simulated: true, broadcast: e.signature !== undefined, signature: e.signature, unconfirmed: e.unconfirmed, error: e.vaultError ?? e.message, vault: seen.vault };
    }
  }

  async swap({ pool, amountIn, swapForY, slippageBps = 100, minOut, broadcast = false }) {
    const loaded = await loadPool(this.connection, pool);
    const built = await buildSwap({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, amountIn, swapForY, slippageBps: checkSlippage(slippageBps) });
    checkFloor(built.quote.minOutAmount, minOut);
    const result = await this.#run(built.instructions, [], broadcast);
    return plain({ ...result, expectedOut: built.quote.outAmount.toString(), minOut: built.quote.minOutAmount.toString(), priceImpact: built.quote.priceImpact.toString() });
  }

  /** Sends transaction sets in order, stopping at the first failure. */
  async #runSets(sets, broadcast) {
    const steps = [];
    for (const instructions of sets) {
      // An RPC error on a later step must not lose the signatures of the steps already sent.
      const step = await this.#run(instructions, [], broadcast).catch((e) => ({ ok: false, simulated: false, broadcast: false, error: e.message }));
      steps.push(step);
      if (!step.ok) break;
    }
    return plain({ ok: steps.length > 0 && steps.every((s) => s.ok), steps });
  }

  async openPosition({ pool, amountX, amountY, minBin, maxBin, minPrice, maxPrice, binsEachSide = 10, strategy = 'spot', slippageBps = 100, broadcast = false }) {
    const loaded = await loadPool(this.connection, pool);
    const built = await buildOpenPosition({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, amountX, amountY, minBin, maxBin, minPrice, maxPrice, binsEachSide, strategy, slippageBps: checkSlippage(slippageBps) });
    const result = await this.#run(built.instructions, [built.position], broadcast);
    const summary = { ...result, position: keyIfSent(result, built.position.publicKey), lowerBin: built.lower, upperBin: built.upper };
    if (!result.ok || !built.addAfterInit) return plain(summary);
    if (!broadcast) return plain({ ...summary, note: 'A wide position adds liquidity in later transactions. Only creating it was simulated, so agentLamportsCost leaves out their rent.' });
    try {
      const adds = await this.#runSets(await built.addAfterInit(), true);
      return plain({ ...summary, ok: adds.ok, addSteps: adds.steps });
    } catch (e) {
      return plain({ ...summary, ok: false, error: `The position was created, and adding liquidity failed: ${e.message}` });
    }
  }

  async addLiquidity({ pool, position, amountX, amountY, strategy = 'spot', slippageBps = 100, broadcast = false }) {
    const loaded = await loadPool(this.connection, pool);
    const instructions = await buildAddLiquidity({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, position, amountX, amountY, strategy, slippageBps: checkSlippage(slippageBps) });
    return plain(await this.#run(instructions, [], broadcast));
  }

  async removeLiquidity({ pool, position, bps = 10_000, fromBin, toBin, broadcast = false }) {
    const loaded = await loadPool(this.connection, pool);
    return this.#runSets(await buildRemoveLiquidity({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, position, bps, fromBin, toBin }), broadcast);
  }

  async claimFees({ pool, position, broadcast = false }) {
    const loaded = await loadPool(this.connection, pool);
    return this.#runSets(await buildClaimFees({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, position }), broadcast);
  }

  async claimReward({ pool, position, broadcast = false }) {
    const loaded = await loadPool(this.connection, pool);
    return this.#runSets(await buildClaimReward({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, position }), broadcast);
  }

  async resizePosition({ pool, position, side, bins, grow, broadcast = false }) {
    const loaded = await loadPool(this.connection, pool);
    return this.#runSets(await buildResize({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, position, side, bins, grow }), broadcast);
  }

  /**
   * Moves a position to a new range: closes it, then opens a new one with what came back.
   * This takes several transactions. If one fails, the funds stay in the vault wallet.
   * The new deposit counts against the spend budget.
   */
  async rebalance({ pool, position, minBin, maxBin, minPrice, maxPrice, binsEachSide, strategy = 'spot', slippageBps = 100, broadcast = false }) {
    const loaded = await loadPool(this.connection, pool);
    // Check the new range and slippage first, because nothing should close if the new position cannot open.
    await resolveRange(loaded, { minBin, maxBin, minPrice, maxPrice, binsEachSide });
    checkSlippage(slippageBps);
    const accountX = walletAta(this.vault, loaded.tokenX.publicKey, loaded.tokenX.owner);
    const accountY = walletAta(this.vault, loaded.tokenY.publicKey, loaded.tokenY.owner);
    const read = async () => [
      (await getAccount(this.connection, accountX, 'confirmed', loaded.tokenX.owner)).amount,
      (await getAccount(this.connection, accountY, 'confirmed', loaded.tokenY.owner)).amount,
    ];
    const sets = await buildClosePosition({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, position });
    if (!broadcast) {
      const closing = await this.#runSets(sets, false);
      return plain({ ...closing, note: 'Only closing was simulated. The new position depends on what the close returns.' });
    }
    const before = await read();
    const closed = await this.#runSets(sets, true);
    if (!closed.ok) return plain({ ...closed, stage: 'close' });
    try {
      const after = await read();
      const opened = await this.openPosition({ pool, amountX: after[0] - before[0], amountY: after[1] - before[1], minBin, maxBin, minPrice, maxPrice, binsEachSide, strategy, slippageBps, broadcast: true });
      return plain({ ok: opened.ok, stage: 'open', closed: closed.steps, opened });
    } catch (e) {
      return plain({ ok: false, stage: 'open', closed: closed.steps, error: `The old position closed and its funds are in the vault wallet. Opening the new one failed: ${e.message}` });
    }
  }

  async createDlmmPool({ mintX, mintY, binStep, feeBps, price, limitOrders = false, broadcast = false }) {
    const built = await buildCreatePool({ connection: this.connection, vault: this.vault, agent: this.agent.publicKey, mintX, mintY, binStep, feeBps, price, limitOrders });
    return plain({ ...(await this.#run(built.instructions, [], broadcast)), pool: built.pool, activeBin: built.activeId });
  }

  async limitPlace({ pool, side, bin, amount, broadcast = false }) {
    const loaded = await loadPool(this.connection, pool);
    const built = await buildLimitPlace({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, side, bins: [{ id: bin, amount }] });
    const result = await this.#run(built.instructions, [built.order], broadcast);
    return plain({ ...result, order: keyIfSent(result, built.order.publicKey) });
  }

  async limitCancel({ pool, order, bin, broadcast = false }) {
    const loaded = await loadPool(this.connection, pool);
    return plain(await this.#run(await buildLimitCancel({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, order, binIds: [bin] }), [], broadcast));
  }

  async positions({ pool }) {
    const loaded = await loadPool(this.connection, pool);
    const { userPositions } = await loaded.getPositionsByUserAndLbPair(this.wallet);
    return plain(userPositions.map((p) => ({
      position: p.publicKey, lowerBin: p.positionData.lowerBinId, upperBin: p.positionData.upperBinId,
      amountX: p.positionData.totalXAmount, amountY: p.positionData.totalYAmount,
      feeX: p.positionData.feeX.toString(), feeY: p.positionData.feeY.toString(),
    })));
  }

  async closePosition({ pool, position, broadcast = false }) {
    const loaded = await loadPool(this.connection, pool);
    return this.#runSets(await buildClosePosition({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, position }), broadcast);
  }

  // DAMM v2

  async dammPoolInfo(address) {
    const { state } = await loadDamm(this.connection, address);
    return plain({ pool: address, tokenA: state.tokenAMint, tokenB: state.tokenBMint, liquidity: state.liquidity.toString(), sqrtPrice: state.sqrtPrice.toString(), status: state.poolStatus });
  }

  async dammQuote({ pool, inputMint, amountIn, slippageBps = 100 }) {
    const loaded = await loadDamm(this.connection, pool);
    const { quote, output } = await buildDammSwap({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, inputMint, amountIn, slippageBps: checkSlippage(slippageBps) });
    return plain({ inToken: inputMint, outToken: output, amountIn: String(amountIn), expectedOut: quote.swapOutAmount.toString(), minOut: quote.minSwapOutAmount.toString(), priceImpact: quote.priceImpact.toString() });
  }

  async dammSwap({ pool, inputMint, amountIn, slippageBps = 100, minOut, broadcast = false }) {
    const loaded = await loadDamm(this.connection, pool);
    const built = await buildDammSwap({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, inputMint, amountIn, slippageBps: checkSlippage(slippageBps) });
    checkFloor(built.quote.minSwapOutAmount, minOut);
    const result = await this.#run(built.instructions, [], broadcast);
    return plain({ ...result, expectedOut: built.quote.swapOutAmount.toString(), minOut: built.quote.minSwapOutAmount.toString(), priceImpact: built.quote.priceImpact.toString() });
  }

  async dammPositions({ pool }) {
    return plain(await listDammPositions({ pool: await loadDamm(this.connection, pool), vault: this.vault }));
  }

  async dammOpen({ pool, amount, isTokenA = true, slippageBps = 300, broadcast = false }) {
    const loaded = await loadDamm(this.connection, pool);
    const built = await buildDammOpen({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, amount, isTokenA, slippageBps: checkSlippage(slippageBps) });
    const result = await this.#run(built.instructions, [built.positionNft], broadcast);
    return plain({ ...result, position: keyIfSent(result, built.position) });
  }

  async dammClaim({ pool, position, broadcast = false }) {
    const loaded = await loadDamm(this.connection, pool);
    const nftAccount = await dammNftAccount(loaded, position);
    const built = await buildDammClaim({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, position: new PublicKey(position), nftAccount });
    return plain(await this.#run(built.instructions, [], broadcast));
  }

  async dammClose({ pool, position, slippageBps = 100, broadcast = false }) {
    const loaded = await loadDamm(this.connection, pool);
    const nftAccount = await dammNftAccount(loaded, position);
    const built = await buildDammClose({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, position: new PublicKey(position), nftAccount, slippageBps: checkSlippage(slippageBps) });
    return plain(await this.#run(built.instructions, [], broadcast));
  }

  async dammAdd({ pool, position, amount, isTokenA = true, slippageBps = 300, broadcast = false }) {
    const loaded = await loadDamm(this.connection, pool);
    const nftAccount = await dammNftAccount(loaded, position);
    return plain(await this.#run((await buildDammAdd({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, position, nftAccount, amount, isTokenA, slippageBps: checkSlippage(slippageBps) })).instructions, [], broadcast));
  }

  async dammRemove({ pool, position, bps, slippageBps = 100, broadcast = false }) {
    const loaded = await loadDamm(this.connection, pool);
    const nftAccount = await dammNftAccount(loaded, position);
    return plain(await this.#run((await buildDammRemove({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, position, nftAccount, bps, slippageBps: checkSlippage(slippageBps) })).instructions, [], broadcast));
  }

  async dammClaimReward({ pool, position, rewardIndex = 0, broadcast = false }) {
    const loaded = await loadDamm(this.connection, pool);
    const nftAccount = await dammNftAccount(loaded, position);
    return plain(await this.#run((await buildDammClaimReward({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, position: new PublicKey(position), nftAccount, rewardIndex })).instructions, [], broadcast));
  }

  async dammCreatePool({ mintA, mintB, amountA, amountB, feeBps = 100, broadcast = false }) {
    const built = await buildDammCreatePool({ connection: this.connection, vault: this.vault, agent: this.agent.publicKey, mintA, mintB, amountA, amountB, feeBps });
    const result = await this.#run(built.instructions, [built.positionNft], broadcast);
    return plain({ ...result, pool: built.pool, position: keyIfSent(result, built.position) });
  }

  // DBC

  async dbcCreateConfig({ startMarketCapSol, graduationMarketCapSol, feeBps = 100, creatorFeePercent = 100, token2022 = false, broadcast = false }) {
    const state = await fetchVault(this.connection, this.vault);
    if (!state || !(state.actions & ACTIONS.LAUNCH)) return plain({ ok: false, simulated: false, broadcast: false, error: 'ActionDisabled' });
    const built = await buildDbcConfig({ connection: this.connection, vault: this.vault, agent: this.agent.publicKey, startMarketCapSol, graduationMarketCapSol, feeBps, creatorFeePercent, token2022 });
    const result = await this.#run(built.instructions, [built.config], broadcast);
    return plain({ ...result, config: keyIfSent(result, built.config.publicKey) });
  }

  async dbcLaunch({ config, name, symbol, uri, broadcast = false }) {
    const built = await buildDbcLaunch({ connection: this.connection, vault: this.vault, agent: this.agent.publicKey, config, name, symbol, uri });
    const result = await this.#run(built.instructions, [built.baseMint], broadcast);
    return plain({ ...result, mint: built.baseMint.publicKey, pool: built.pool, note: 'The owner must list this pool before the agent can trade it.' });
  }

  async dbcClaimCreatorFee({ pool, broadcast = false }) {
    return plain(await this.#run(await buildDbcClaimCreator({ pool: await loadDbc(this.connection, pool), vault: this.vault, agent: this.agent.publicKey }), [], broadcast));
  }

  async dbcClaimPartnerFee({ pool, broadcast = false }) {
    return plain(await this.#run(await buildDbcClaimPartner({ pool: await loadDbc(this.connection, pool), vault: this.vault, agent: this.agent.publicKey }), [], broadcast));
  }

  async dbcWithdrawSurplus({ pool, role = 'creator', broadcast = false }) {
    return plain(await this.#run(await buildDbcWithdrawSurplus({ pool: await loadDbc(this.connection, pool), vault: this.vault, agent: this.agent.publicKey, role }), [], broadcast));
  }

  async dbcWithdrawLeftover({ pool, broadcast = false }) {
    return plain(await this.#run(await buildDbcWithdrawLeftover({ pool: await loadDbc(this.connection, pool), vault: this.vault, agent: this.agent.publicKey }), [], broadcast));
  }

  async dbcPoolInfo(address) {
    const { state, config } = await loadDbc(this.connection, address);
    return plain({
      pool: address, baseMint: state.baseMint, quoteMint: config.quoteMint, baseReserve: state.baseReserve.toString(), quoteReserve: state.quoteReserve.toString(),
      migrationQuoteThreshold: config.migrationQuoteThreshold.toString(), migrated: Boolean(state.isMigrated),
    });
  }

  async dbcQuote({ pool, amountIn, sell = false, slippageBps = 100 }) {
    const loaded = await loadDbc(this.connection, pool);
    const { quote } = await buildDbcSwap({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, amountIn, sell, slippageBps: checkSlippage(slippageBps) });
    return plain({ amountIn: String(amountIn), sell, expectedOut: quote.outputAmount.toString(), minOut: quote.minimumAmountOut.toString() });
  }

  async dbcSwap({ pool, amountIn, sell = false, slippageBps = 100, minOut, broadcast = false }) {
    const loaded = await loadDbc(this.connection, pool);
    const built = await buildDbcSwap({ pool: loaded, vault: this.vault, agent: this.agent.publicKey, amountIn, sell, slippageBps: checkSlippage(slippageBps) });
    checkFloor(built.quote.minimumAmountOut, minOut);
    const result = await this.#run(built.instructions, [], broadcast);
    return plain({ ...result, expectedOut: built.quote.outputAmount.toString(), minOut: built.quote.minimumAmountOut.toString() });
  }
}
