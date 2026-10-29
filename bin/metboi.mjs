#!/usr/bin/env node
// CLI. Agent commands use METBOI_AGENT_KEY. Owner commands use METBOI_OWNER_KEY and read policy from a JSON file.
// Actions only simulate unless --broadcast is passed.
import fs from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { MAX_SLIPPAGE_BPS, agentFromEnv, loadKeypair } from '../sdk/agent.mjs';
import { ownerIx, send, simulate, vaultPda, walletPda } from '../sdk/index.mjs';
import { buildOwnerDammClose, buildOwnerDlmmClose, buildOwnerLimitCancel, scanWallet } from '../sdk/owner.mjs';

const BOOLEAN_FLAGS = new Set(['broadcast', 'sell', 'token-2022', 'limit-orders']);
const VALUE_FLAGS = new Set([
  'agent', 'amount', 'amount-a', 'amount-b', 'bin', 'bin-step', 'bins', 'bps', 'config', 'creator-fee-percent', 'expires', 'fee-bps', 'from', 'from-bin', 'graduation-mc', 'id',
  'input-mint', 'lamports', 'max-bin', 'max-price', 'min-bin', 'min-out', 'min-price', 'mint', 'mint-a', 'mint-b', 'mint-x', 'mint-y', 'name', 'order', 'owner-key', 'policy', 'pool',
  'position', 'price', 'reward-index', 'role', 'rpc', 'side', 'slippage', 'start-mc', 'strategy', 'symbol', 'to', 'to-bin', 'uri', 'vault', 'x', 'y',
]);
/** The flags each command reads. Any other flag would be ignored without notice, so it is refused. */
const COMMAND_FLAGS = {
  status: ['rpc', 'vault'],
  'dlmm-pool': ['pool', 'rpc', 'vault'],
  'dlmm-positions': ['pool', 'rpc', 'vault'],
  'dlmm-quote': ['amount', 'pool', 'rpc', 'side', 'slippage', 'vault'],
  'dlmm-swap': ['amount', 'broadcast', 'min-out', 'pool', 'rpc', 'side', 'slippage', 'vault'],
  'dlmm-open': ['bins', 'broadcast', 'max-bin', 'max-price', 'min-bin', 'min-price', 'pool', 'rpc', 'strategy', 'vault', 'x', 'y'],
  'dlmm-add': ['broadcast', 'pool', 'position', 'rpc', 'strategy', 'vault', 'x', 'y'],
  'dlmm-remove': ['bps', 'broadcast', 'from-bin', 'pool', 'position', 'rpc', 'to-bin', 'vault'],
  'dlmm-claim': ['broadcast', 'pool', 'position', 'rpc', 'vault'],
  'dlmm-claim-reward': ['broadcast', 'pool', 'position', 'rpc', 'vault'],
  'dlmm-extend': ['bins', 'broadcast', 'pool', 'position', 'rpc', 'side', 'vault'],
  'dlmm-shrink': ['bins', 'broadcast', 'pool', 'position', 'rpc', 'side', 'vault'],
  'dlmm-rebalance': ['bins', 'broadcast', 'max-bin', 'max-price', 'min-bin', 'min-price', 'pool', 'position', 'rpc', 'strategy', 'vault'],
  'dlmm-close': ['broadcast', 'pool', 'position', 'rpc', 'vault'],
  'dlmm-create-pool': ['bin-step', 'broadcast', 'fee-bps', 'limit-orders', 'mint-x', 'mint-y', 'price', 'rpc', 'vault'],
  'dlmm-limit-place': ['amount', 'bin', 'broadcast', 'pool', 'rpc', 'side', 'vault'],
  'dlmm-limit-cancel': ['bin', 'broadcast', 'order', 'pool', 'rpc', 'vault'],
  'damm-pool': ['pool', 'rpc', 'vault'],
  'damm-positions': ['pool', 'rpc', 'vault'],
  'damm-quote': ['amount', 'input-mint', 'pool', 'rpc', 'slippage', 'vault'],
  'damm-swap': ['amount', 'broadcast', 'input-mint', 'min-out', 'pool', 'rpc', 'slippage', 'vault'],
  'damm-open': ['amount', 'broadcast', 'pool', 'rpc', 'side', 'vault'],
  'damm-add': ['amount', 'broadcast', 'pool', 'position', 'rpc', 'side', 'vault'],
  'damm-remove': ['bps', 'broadcast', 'pool', 'position', 'rpc', 'vault'],
  'damm-claim-reward': ['broadcast', 'pool', 'position', 'reward-index', 'rpc', 'vault'],
  'damm-create-pool': ['amount-a', 'amount-b', 'broadcast', 'fee-bps', 'mint-a', 'mint-b', 'rpc', 'vault'],
  'damm-claim': ['broadcast', 'pool', 'position', 'rpc', 'vault'],
  'damm-close': ['broadcast', 'pool', 'position', 'rpc', 'vault'],
  'dbc-pool': ['pool', 'rpc', 'vault'],
  'dbc-quote': ['amount', 'pool', 'rpc', 'sell', 'slippage', 'vault'],
  'dbc-swap': ['amount', 'broadcast', 'min-out', 'pool', 'rpc', 'sell', 'slippage', 'vault'],
  'dbc-create-config': ['broadcast', 'creator-fee-percent', 'fee-bps', 'graduation-mc', 'rpc', 'start-mc', 'token-2022', 'vault'],
  'dbc-launch': ['broadcast', 'config', 'name', 'rpc', 'symbol', 'uri', 'vault'],
  'dbc-claim-creator': ['broadcast', 'pool', 'rpc', 'vault'],
  'dbc-claim-partner': ['broadcast', 'pool', 'rpc', 'vault'],
  'dbc-withdraw-surplus': ['broadcast', 'pool', 'role', 'rpc', 'vault'],
  'dbc-withdraw-leftover': ['broadcast', 'pool', 'rpc', 'vault'],
  init: ['agent', 'broadcast', 'expires', 'id', 'owner-key', 'policy', 'rpc'],
  policy: ['broadcast', 'owner-key', 'policy', 'rpc', 'vault'],
  pause: ['broadcast', 'owner-key', 'rpc', 'vault'],
  resume: ['broadcast', 'owner-key', 'rpc', 'vault'],
  'set-agent': ['agent', 'broadcast', 'expires', 'owner-key', 'rpc', 'vault'],
  'withdraw-sol': ['broadcast', 'lamports', 'owner-key', 'rpc', 'to', 'vault'],
  'withdraw-token': ['amount', 'broadcast', 'from', 'mint', 'owner-key', 'rpc', 'to', 'vault'],
  'owner-scan': ['rpc', 'vault'],
  'owner-dlmm-close': ['broadcast', 'owner-key', 'pool', 'position', 'rpc', 'vault'],
  'owner-damm-close': ['broadcast', 'owner-key', 'pool', 'position', 'rpc', 'slippage', 'vault'],
  'owner-limit-cancel': ['bin', 'broadcast', 'order', 'owner-key', 'pool', 'rpc', 'vault'],
};

const fail = (message) => {
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
};

const [command, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith('--')) fail(`Unexpected argument ${rest[i]}`);
  const key = rest[i].slice(2);
  if (BOOLEAN_FLAGS.has(key)) {
    if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) fail(`--${key} takes no value`);
    flags[key] = true;
  } else if (VALUE_FLAGS.has(key)) {
    if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) fail(`--${key} needs a value`);
    flags[key] = rest[++i];
  } else {
    fail(`Unknown flag --${key}`);
  }
}
for (const flag of Object.keys(flags)) {
  if (COMMAND_FLAGS[command] && !COMMAND_FLAGS[command].includes(flag)) fail(`--${flag} does not apply to ${command}`);
}
const broadcast = flags.broadcast === true;
if (broadcast) console.error('No independent firm has audited Metboi Agentic. Use only funds you can afford to lose.');
const print = (v) => {
  console.log(JSON.stringify(v, null, 1));
  if (v?.ok === false) process.exitCode = 1;
};
const need = (name) => {
  if (flags[name] === undefined) throw new Error(`Missing --${name}`);
  return flags[name];
};
/** A whole-number raw amount. */
const raw = (name) => {
  const value = need(name);
  if (!/^\d+$/.test(value)) throw new Error(`--${name} must be a whole number of raw base units`);
  return value;
};
const integer = (value, name, min, max) => {
  if (!/^-?\d+$/.test(String(value)) || Number(value) < min || Number(value) > max) throw new Error(`--${name} must be a whole number from ${min} to ${max}`);
  return Number(value);
};
const bps = () => integer(need('bps'), 'bps', 1, 10_000);
const optionalInt = (name, min, max) => (flags[name] === undefined ? undefined : integer(flags[name], name, min, max));
const decimal = (name, value = need(name)) => {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`--${name} must be a positive number`);
  return value;
};
const optionalDecimal = (name) => (flags[name] === undefined ? undefined : decimal(name, flags[name]));
const oneOf = (name, options) => {
  const value = need(name);
  if (!options.includes(value)) throw new Error(`--${name} must be ${options.join(' or ')}`);
  return value;
};
const swapForY = () => oneOf('side', ['x-to-y', 'y-to-x']) === 'x-to-y';
const isTokenA = () => oneOf('side', ['a', 'b']) === 'a';
const slippageBps = () => optionalInt('slippage', 0, MAX_SLIPPAGE_BPS);
const minOut = () => (flags['min-out'] === undefined ? undefined : raw('min-out'));
const strategy = () => (flags.strategy === undefined ? undefined : oneOf('strategy', ['spot', 'curve', 'bidask']));
const rangeFlags = () => ({
  minBin: optionalInt('min-bin', -500_000, 500_000), maxBin: optionalInt('max-bin', -500_000, 500_000),
  minPrice: optionalDecimal('min-price'), maxPrice: optionalDecimal('max-price'), binsEachSide: optionalInt('bins', 1, 699),
});
const rpcUrl = () => flags.rpc ?? process.env.METBOI_RPC ?? need('rpc');
const agent = () => agentFromEnv({ rpc: flags.rpc, vault: flags.vault });
const GENESIS = { '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet-beta', 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG': 'devnet' };
const clusterOf = async (connection) => GENESIS[await connection.getGenesisHash()] ?? 'other';
const ownerKey = () => loadKeypair(flags['owner-key'] ?? process.env.METBOI_OWNER_KEY ?? need('owner-key'));

async function ownerRun(build) {
  const owner = ownerKey();
  const connection = new Connection(rpcUrl(), 'confirmed');
  const ix = build(owner.publicKey);
  const cluster = await clusterOf(connection);
  const vault = ix.keys[1]?.pubkey;
  const destination = flags.to;
  if (!broadcast) {
    const sim = await simulate(connection, owner, [ix]);
    return print({ ok: sim.ok, simulated: true, broadcast: false, cluster, vault, destination, error: sim.error ?? sim.err ?? undefined });
  }
  print({ ok: true, broadcast: true, cluster, vault, destination, signature: await send(connection, owner, [ix]) });
}

/** Sends transaction sets in order as the owner, or simulates the first one. */
async function ownerSets(build) {
  const owner = ownerKey();
  const connection = new Connection(rpcUrl(), 'confirmed');
  const sets = await build(connection, owner.publicKey);
  const cluster = await clusterOf(connection);
  if (!broadcast) {
    const sim = await simulate(connection, owner, sets[0]);
    return print({ ok: sim.ok, simulated: true, broadcast: false, cluster, vault: vaultArg(), sets: sets.length, error: sim.error ?? sim.err ?? undefined });
  }
  const signatures = [];
  for (const instructions of sets) {
    try {
      signatures.push(await send(connection, owner, instructions));
    } catch (e) {
      return print({ ok: false, broadcast: true, cluster, vault: vaultArg(), signatures, failedSignature: e.signature, error: e.message });
    }
  }
  print({ ok: true, broadcast: true, cluster, vault: vaultArg(), signatures });
}

const readPolicy = () => JSON.parse(fs.readFileSync(need('policy'), 'utf8'));
const vaultArg = () => new PublicKey(flags.vault ?? process.env.METBOI_VAULT ?? need('vault'));

const commands = {
  status: () => agent().status().then(print),
  'dlmm-pool': () => agent().poolInfo(need('pool')).then(print),
  'dlmm-positions': () => agent().positions({ pool: need('pool') }).then(print),
  'dlmm-quote': () => agent().quote({ pool: need('pool'), amountIn: raw('amount'), swapForY: swapForY(), slippageBps: slippageBps() }).then(print),
  'dlmm-swap': () => agent().swap({ pool: need('pool'), amountIn: raw('amount'), swapForY: swapForY(), minOut: minOut(), slippageBps: slippageBps(), broadcast }).then(print),
  'dlmm-open': () => agent().openPosition({ pool: need('pool'), amountX: raw('x'), amountY: raw('y'), ...rangeFlags(), strategy: strategy(), broadcast }).then(print),
  'dlmm-add': () => agent().addLiquidity({ pool: need('pool'), position: need('position'), amountX: raw('x'), amountY: raw('y'), strategy: strategy(), broadcast }).then(print),
  'dlmm-remove': () => agent().removeLiquidity({ pool: need('pool'), position: need('position'), bps: bps(), fromBin: optionalInt('from-bin', -500_000, 500_000), toBin: optionalInt('to-bin', -500_000, 500_000), broadcast }).then(print),
  'dlmm-claim': () => agent().claimFees({ pool: need('pool'), position: need('position'), broadcast }).then(print),
  'dlmm-claim-reward': () => agent().claimReward({ pool: need('pool'), position: need('position'), broadcast }).then(print),
  'dlmm-extend': () => agent().resizePosition({ pool: need('pool'), position: need('position'), side: oneOf('side', ['lower', 'upper']), bins: integer(need('bins'), 'bins', 1, 1400), grow: true, broadcast }).then(print),
  'dlmm-shrink': () => agent().resizePosition({ pool: need('pool'), position: need('position'), side: oneOf('side', ['lower', 'upper']), bins: integer(need('bins'), 'bins', 1, 1400), grow: false, broadcast }).then(print),
  'dlmm-rebalance': () => agent().rebalance({ pool: need('pool'), position: need('position'), ...rangeFlags(), strategy: strategy(), broadcast }).then(print),
  'dlmm-close': () => agent().closePosition({ pool: need('pool'), position: need('position'), broadcast }).then(print),
  'dlmm-create-pool': () => agent().createDlmmPool({ mintX: need('mint-x'), mintY: need('mint-y'), binStep: integer(need('bin-step'), 'bin-step', 1, 10_000), feeBps: integer(need('fee-bps'), 'fee-bps', 1, 9_999), price: decimal('price'), limitOrders: flags['limit-orders'] === true, broadcast }).then(print),
  'dlmm-limit-place': () => agent().limitPlace({ pool: need('pool'), side: oneOf('side', ['ask', 'bid']), bin: integer(need('bin'), 'bin', -500_000, 500_000), amount: raw('amount'), broadcast }).then(print),
  'dlmm-limit-cancel': () => agent().limitCancel({ pool: need('pool'), order: need('order'), bin: integer(need('bin'), 'bin', -500_000, 500_000), broadcast }).then(print),
  'damm-pool': () => agent().dammPoolInfo(need('pool')).then(print),
  'damm-positions': () => agent().dammPositions({ pool: need('pool') }).then(print),
  'damm-quote': () => agent().dammQuote({ pool: need('pool'), inputMint: need('input-mint'), amountIn: raw('amount'), slippageBps: slippageBps() }).then(print),
  'damm-swap': () => agent().dammSwap({ pool: need('pool'), inputMint: need('input-mint'), amountIn: raw('amount'), minOut: minOut(), slippageBps: slippageBps(), broadcast }).then(print),
  'damm-open': () => agent().dammOpen({ pool: need('pool'), amount: raw('amount'), isTokenA: isTokenA(), broadcast }).then(print),
  'damm-add': () => agent().dammAdd({ pool: need('pool'), position: need('position'), amount: raw('amount'), isTokenA: isTokenA(), broadcast }).then(print),
  'damm-remove': () => agent().dammRemove({ pool: need('pool'), position: need('position'), bps: bps(), broadcast }).then(print),
  'damm-claim-reward': () => agent().dammClaimReward({ pool: need('pool'), position: need('position'), rewardIndex: optionalInt('reward-index', 0, 1) ?? 0, broadcast }).then(print),
  'damm-create-pool': () => agent().dammCreatePool({ mintA: need('mint-a'), mintB: need('mint-b'), amountA: raw('amount-a'), amountB: raw('amount-b'), feeBps: optionalInt('fee-bps', 1, 9_999) ?? 100, broadcast }).then(print),
  'damm-claim': () => agent().dammClaim({ pool: need('pool'), position: need('position'), broadcast }).then(print),
  'damm-close': () => agent().dammClose({ pool: need('pool'), position: need('position'), broadcast }).then(print),
  'dbc-pool': () => agent().dbcPoolInfo(need('pool')).then(print),
  'dbc-quote': () => agent().dbcQuote({ pool: need('pool'), amountIn: raw('amount'), sell: flags.sell === true, slippageBps: slippageBps() }).then(print),
  'dbc-swap': () => agent().dbcSwap({ pool: need('pool'), amountIn: raw('amount'), sell: flags.sell === true, minOut: minOut(), slippageBps: slippageBps(), broadcast }).then(print),
  'dbc-create-config': () => agent().dbcCreateConfig({ startMarketCapSol: decimal('start-mc'), graduationMarketCapSol: decimal('graduation-mc'), feeBps: optionalInt('fee-bps', 1, 9_999) ?? 100, creatorFeePercent: optionalInt('creator-fee-percent', 0, 100) ?? 100, token2022: flags['token-2022'] === true, broadcast }).then(print),
  'dbc-launch': () => agent().dbcLaunch({ config: need('config'), name: need('name'), symbol: need('symbol'), uri: need('uri'), broadcast }).then(print),
  'dbc-claim-creator': () => agent().dbcClaimCreatorFee({ pool: need('pool'), broadcast }).then(print),
  'dbc-claim-partner': () => agent().dbcClaimPartnerFee({ pool: need('pool'), broadcast }).then(print),
  'dbc-withdraw-surplus': () => agent().dbcWithdrawSurplus({ pool: need('pool'), role: flags.role === undefined ? 'creator' : oneOf('role', ['creator', 'partner']), broadcast }).then(print),
  'dbc-withdraw-leftover': () => agent().dbcWithdrawLeftover({ pool: need('pool'), broadcast }).then(print),
  init: () => ownerRun((owner) => {
    const id = BigInt(integer(flags.id ?? 0, 'id', 0, Number.MAX_SAFE_INTEGER));
    const vault = vaultPda(owner, id);
    print({ vault, wallet: walletPda(vault) });
    return ownerIx.initialize({ owner, id, agent: need('agent'), agentExpiresAt: integer(flags.expires ?? 0, 'expires', 0, Number.MAX_SAFE_INTEGER), policy: readPolicy() });
  }),
  policy: () => ownerRun((owner) => ownerIx.updatePolicy({ owner, vault: vaultArg(), policy: readPolicy() })),
  pause: () => ownerRun((owner) => ownerIx.setPaused({ owner, vault: vaultArg(), paused: true })),
  resume: () => ownerRun((owner) => ownerIx.setPaused({ owner, vault: vaultArg(), paused: false })),
  'set-agent': () => ownerRun((owner) => ownerIx.setAgent({ owner, vault: vaultArg(), agent: need('agent'), agentExpiresAt: integer(flags.expires ?? 0, 'expires', 0, Number.MAX_SAFE_INTEGER) })),
  'withdraw-sol': () => ownerRun((owner) => ownerIx.withdrawSol({ owner, vault: vaultArg(), to: need('to'), lamports: raw('lamports') })),
  'withdraw-token': async () => {
    const connection = new Connection(rpcUrl(), 'confirmed');
    const info = await connection.getAccountInfo(new PublicKey(need('mint')));
    if (!info) throw new Error('Mint not found');
    return ownerRun((owner) => ownerIx.withdrawToken({ owner, vault: vaultArg(), mint: need('mint'), from: need('from'), to: need('to'), amount: raw('amount'), tokenProgram: info.owner }));
  },
  'owner-scan': () => scanWallet({ connection: new Connection(rpcUrl(), 'confirmed'), vault: vaultArg() }).then(print),
  'owner-dlmm-close': () => ownerSets((connection, owner) => buildOwnerDlmmClose({ connection, vault: vaultArg(), owner, pool: need('pool'), position: need('position') })),
  'owner-damm-close': () => ownerSets((connection, owner) => buildOwnerDammClose({ connection, vault: vaultArg(), owner, pool: need('pool'), position: need('position'), slippageBps: slippageBps() })),
  'owner-limit-cancel': () => ownerSets((connection, owner) => buildOwnerLimitCancel({ connection, vault: vaultArg(), owner, pool: need('pool'), order: need('order'), bin: integer(need('bin'), 'bin', -500_000, 500_000) })),
};

const run = commands[command];
if (!run) {
  console.error(`Usage: metboi <${Object.keys(commands).join('|')}> [flags] [--broadcast]`);
  fail(`Unknown command ${command ?? '(none)'}`);
}
// Errors go to stdout as JSON too, so a caller that discards stderr still sees why a command failed.
await Promise.resolve().then(run).catch((e) => { console.log(JSON.stringify({ ok: false, signature: e.signature, error: e.message })); process.exit(1); });
process.exit(process.exitCode ?? 0);
