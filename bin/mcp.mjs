#!/usr/bin/env node
// MCP server for agents. Holds the agent key only, so it exposes no policy or withdrawal tool.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { agentFromEnv, MAX_SLIPPAGE_BPS } from '../sdk/agent.mjs';

let ops;
try {
  ops = agentFromEnv();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const server = new McpServer({ name: 'metboi-agentic', version: '0.1.0' });

const address = z.string().min(32).max(44);
const amount = z.string().regex(/^\d+$/).describe('Raw base units as a string');
const slippageBps = z.number().int().min(0).max(MAX_SLIPPAGE_BPS).default(100);
const minOut = amount.optional().describe('Refuse the swap if the current floor is below this, for example the minOut from your quote');
const broadcast = z.boolean().default(false).describe('False only simulates. True sends after a passing simulation.');

function tool(name, description, inputSchema, handler) {
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      const result = await handler(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], isError: result?.ok === false };
    } catch (e) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }], isError: true };
    }
  });
}

tool('vault_status', 'Balances, allowed pools, and remaining spend budget for this agent.', {}, () => ops.status());

tool('dlmm_pool_info', 'Tokens, bin step, active bin, and price of a DLMM pool.', { pool: address }, ({ pool }) => ops.poolInfo(pool));
tool('dlmm_quote', 'Quote a DLMM swap without simulating a transaction.', { pool: address, amountIn: amount, swapForY: z.boolean(), slippageBps }, (a) => ops.quote(a));
tool('dlmm_swap', 'Swap on an allowlisted DLMM pool from the vault wallet.', { pool: address, amountIn: amount, swapForY: z.boolean(), slippageBps, minOut, broadcast }, (a) => ops.swap(a));
tool('dlmm_list_positions', 'List vault wallet positions in a DLMM pool.', { pool: address }, (a) => ops.positions(a));
const range = { minBin: z.number().int().optional(), maxBin: z.number().int().optional(), minPrice: z.number().positive().optional().describe('Token Y per token X'), maxPrice: z.number().positive().optional(), binsEachSide: z.number().int().min(1).max(699).optional() };
const strategy = z.enum(['spot', 'curve', 'bidask']).default('spot');
tool('dlmm_open_position', 'Open a DLMM position. Set the range by bins, by prices, or by a width around the active bin, up to 1400 bins.', { pool: address, amountX: amount, amountY: amount, ...range, strategy, slippageBps, broadcast }, (a) => ops.openPosition(a));
tool('dlmm_add_liquidity', 'Add liquidity across an existing DLMM position.', { pool: address, position: address, amountX: amount, amountY: amount, strategy, slippageBps, broadcast }, (a) => ops.addLiquidity(a));
tool('dlmm_remove_liquidity', 'Remove a share of a DLMM position, optionally from a sub-range of bins. The position stays open.', { pool: address, position: address, bps: z.number().int().min(1).max(10_000), fromBin: z.number().int().optional(), toBin: z.number().int().optional(), broadcast }, (a) => ops.removeLiquidity(a));
tool('dlmm_claim_fees', 'Claim swap fees of a DLMM position into the vault wallet.', { pool: address, position: address, broadcast }, (a) => ops.claimFees(a));
tool('dlmm_claim_reward', 'Claim farming rewards of a DLMM position into the vault wallet.', { pool: address, position: address, broadcast }, (a) => ops.claimReward(a));
tool('dlmm_resize_position', 'Extend or shrink a DLMM position range on one side. Shrinking needs those bins to be empty.', { pool: address, position: address, side: z.enum(['lower', 'upper']), bins: z.number().int().min(1), grow: z.boolean(), broadcast }, (a) => ops.resizePosition(a));
tool('dlmm_rebalance', 'Move a DLMM position to a new range by closing it and opening a new one. Takes several transactions, and the new deposit counts against budget.', { pool: address, position: address, ...range, strategy, slippageBps, broadcast }, (a) => ops.rebalance(a));
tool('dlmm_close_position', 'Remove all liquidity, claim fees, and close a DLMM position.', { pool: address, position: address, broadcast }, (a) => ops.closePosition(a));
tool('dlmm_create_pool', 'Create a new DLMM pool through the vault, which must hold the token. Needs the LAUNCH action. The owner must list it before the agent can use it.', { mintX: address, mintY: address, binStep: z.number().int().positive(), feeBps: z.number().int().positive(), price: z.number().positive().describe('Token Y per token X'), limitOrders: z.boolean().default(false), broadcast }, (a) => ops.createDlmmPool(a));
tool('dlmm_limit_place', 'Place a DLMM limit order in one bin. Only for pools with limit orders enabled.', { pool: address, side: z.enum(['ask', 'bid']), bin: z.number().int(), amount, broadcast }, (a) => ops.limitPlace(a));
tool('dlmm_limit_cancel', 'Cancel a DLMM limit order in one bin.', { pool: address, order: address, bin: z.number().int(), broadcast }, (a) => ops.limitCancel(a));

tool('damm_pool_info', 'Tokens, liquidity, and price of a DAMM v2 pool.', { pool: address }, ({ pool }) => ops.dammPoolInfo(pool));
tool('damm_quote', 'Quote a DAMM v2 swap without simulating a transaction.', { pool: address, inputMint: address, amountIn: amount, slippageBps }, (a) => ops.dammQuote(a));
tool('damm_swap', 'Swap on an allowlisted DAMM v2 pool from the vault wallet.', { pool: address, inputMint: address, amountIn: amount, slippageBps, minOut, broadcast }, (a) => ops.dammSwap(a));
tool('damm_list_positions', 'List vault wallet positions and unclaimed fees in a DAMM v2 pool.', { pool: address }, (a) => ops.dammPositions(a));
tool('damm_open_position', 'Open a DAMM v2 position from an amount of one token. The other token is quoted to match.', { pool: address, amount, isTokenA: z.boolean().describe('True when amount is token A'), slippageBps, broadcast }, (a) => ops.dammOpen(a));
tool('damm_add_liquidity', 'Add to a DAMM v2 position from an amount of one token.', { pool: address, position: address, amount, isTokenA: z.boolean(), slippageBps, broadcast }, (a) => ops.dammAdd(a));
tool('damm_remove_liquidity', 'Remove a share of a DAMM v2 position. The position stays open.', { pool: address, position: address, bps: z.number().int().min(1).max(10_000), slippageBps, broadcast }, (a) => ops.dammRemove(a));
tool('damm_claim_reward', 'Claim a farming reward of a DAMM v2 position.', { pool: address, position: address, rewardIndex: z.number().int().min(0).max(1).default(0), broadcast }, (a) => ops.dammClaimReward(a));
tool('damm_create_pool', 'Create a DAMM v2 pool funded from the vault wallet. Needs the LAUNCH action.', { mintA: address, mintB: address, amountA: amount, amountB: amount, feeBps: z.number().int().positive().default(100), broadcast }, (a) => ops.dammCreatePool(a));
tool('damm_claim_fees', 'Claim unclaimed fees of a DAMM v2 position into the vault wallet.', { pool: address, position: address, broadcast }, (a) => ops.dammClaim(a));
tool('damm_close_position', 'Remove all liquidity from a DAMM v2 position and close it.', { pool: address, position: address, slippageBps, broadcast }, (a) => ops.dammClose(a));

tool('dbc_pool_info', 'Reserves, migration threshold, and migration state of a DBC pool.', { pool: address }, ({ pool }) => ops.dbcPoolInfo(pool));
tool('dbc_quote', 'Quote a DBC buy or sell without simulating a transaction.', { pool: address, amountIn: amount, sell: z.boolean().default(false), slippageBps }, (a) => ops.dbcQuote(a));
tool('dbc_swap', 'Buy or sell on an allowlisted DBC pool from the vault wallet.', { pool: address, amountIn: amount, sell: z.boolean().default(false), slippageBps, minOut, broadcast }, (a) => ops.dbcSwap(a));

tool('dbc_create_config', 'Create a bonding curve config. Fees and leftovers go to the vault wallet. Signed and paid by the agent key.', { startMarketCapSol: z.number().positive(), graduationMarketCapSol: z.number().positive(), feeBps: z.number().int().positive().default(100), creatorFeePercent: z.number().int().min(0).max(100).default(100), token2022: z.boolean().default(false), broadcast }, (a) => ops.dbcCreateConfig(a));
tool('dbc_launch', 'Launch a token on a DBC config. The vault wallet is the creator. Needs the LAUNCH action. The owner must list the new pool before the agent can trade it.', { config: address, name: z.string().min(1).max(32), symbol: z.string().min(1).max(10), uri: z.string().url().max(200), broadcast }, (a) => ops.dbcLaunch(a));
tool('dbc_claim_creator_fee', 'Claim creator trading fees of a DBC pool into the vault wallet.', { pool: address, broadcast }, (a) => ops.dbcClaimCreatorFee(a));
tool('dbc_claim_partner_fee', 'Claim partner trading fees of a DBC pool into the vault wallet.', { pool: address, broadcast }, (a) => ops.dbcClaimPartnerFee(a));
tool('dbc_withdraw_surplus', 'Withdraw surplus of a completed DBC curve into the vault wallet.', { pool: address, role: z.enum(['creator', 'partner']).default('creator'), broadcast }, (a) => ops.dbcWithdrawSurplus(a));
tool('dbc_withdraw_leftover', 'Withdraw leftover base tokens of a migrated DBC pool to the leftover receiver set in its config, which is the vault wallet for configs made with dbc_create_config.', { pool: address, broadcast }, (a) => ops.dbcWithdrawLeftover(a));

await server.connect(new StdioServerTransport());
