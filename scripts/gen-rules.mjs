// Generates programs/metboi-agentic/src/rules.rs and sdk/rules.json from the Meteora IDLs.
// Rules name accounts instead of indexes, so a position can never be mistyped.
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const load = (n) => JSON.parse(fs.readFileSync(new URL(`../idl/meteora/${n}.json`, import.meta.url)));
const SWAP = 'SWAP', ADD = 'ADD_LIQUIDITY', REMOVE = 'REMOVE_LIQUIDITY', CLAIM = 'CLAIM', POS = 'POSITION', LAUNCH = 'LAUNCH';

const dlmmAdd = (ix) => ({ ix, action: ADD, sender: 'sender', pool: 'lb_pair', tokens: ['user_token_x', 'user_token_y'], dlmmPosition: 'position' });
const dlmmRemove = (ix) => ({ ix, action: REMOVE, sender: 'sender', tokens: ['user_token_x', 'user_token_y'], dlmmPosition: 'position' });
const dlmmClose = (ix) => ({ ix, action: POS, sender: 'sender', wallet: ['rent_receiver'], dlmmPosition: 'position' });
const dbcLaunch = (ix) => ({ ix, action: LAUNCH, wallet: ['creator', 'payer'], dbcConfig: 'config' });
const dbcClaim = (ix, sender) => ({ ix, action: CLAIM, sender, tokens: ['token_a_account', 'token_b_account'] });
const dbcSwap = (ix) => ({ ix, action: SWAP, sender: 'payer', pool: 'pool', tokens: ['input_token_account', 'output_token_account'], none: ['referral_token_account'] });

const sizeOf = (idl) => {
  const size = (t) => {
    if (typeof t === 'string') return { u8: 1, i8: 1, bool: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, pubkey: 32 }[t] ?? fail(t);
    if (t.array) return size(t.array[0]) * t.array[1];
    if (t.defined) return idl.types.find((x) => x.name === t.defined.name).type.fields.reduce((n, f) => n + size(f.type), 0);
    return fail(JSON.stringify(t));
  };
  const fail = (t) => { throw new Error(`variable size field: ${t}`); };
  return size;
};
const ANCHOR_DISC = 8;
function offsetOf(idl, typeName, fieldName) {
  const size = sizeOf(idl);
  let offset = ANCHOR_DISC;
  for (const f of idl.types.find((t) => t.name === typeName).type.fields) {
    if (f.name === fieldName) return offset;
    offset += size(f.type);
  }
  throw new Error(`${typeName}.${fieldName} not found`);
}
const TARGETS = {
  DLMM: { idl: load('dlmm'), rules: [
    ...['swap', 'swap2'].map((ix) => ({ ix, action: SWAP, sender: 'user', pool: 'lb_pair', tokens: ['user_token_in', 'user_token_out'], none: ['host_fee_in'] })),
    { ix: 'initialize_customizable_permissionless_lb_pair2', action: LAUNCH, wallet: ['funder'], tokens: ['user_token_x', 'user_token_y'] },
    { ix: 'initialize_position', action: POS, wallet: ['owner'], payer: ['payer'], pool: 'lb_pair' },
    { ix: 'initialize_position2', action: POS, wallet: ['owner'], payer: ['payer'], pool: 'lb_pair' },
    ...['increase_position_length', 'increase_position_length2'].map((ix) => ({ ix, action: POS, sender: 'owner', payer: ['funder'], dlmmPosition: 'position' })),
    { ix: 'decrease_position_length', action: POS, sender: 'owner', wallet: ['rent_receiver'], dlmmPosition: 'position' },
    { ix: 'place_limit_order', action: SWAP, sender: 'sender', wallet: ['owner'], payer: ['payer'], pool: 'lb_pair', tokens: ['user_token'], fresh: ['limit_order'] },
    { ix: 'cancel_limit_order', action: SWAP, sender: 'owner', tokens: ['owner_token_x', 'owner_token_y'] },
    { ix: 'close_limit_order_if_empty', action: SWAP, sender: 'owner', wallet: ['rent_receiver'] },
    ...['add_liquidity', 'add_liquidity2', 'add_liquidity_by_strategy', 'add_liquidity_by_strategy2'].map(dlmmAdd),
    { ix: 'rebalance_liquidity', action: ADD, sender: 'owner', wallet: ['rent_payer'], pool: 'lb_pair', tokens: ['user_token_x', 'user_token_y'], dlmmPosition: 'position', noRemoves: true, zeroParams: ['should_claim_fee', 'should_claim_reward'] },
    ...['remove_liquidity', 'remove_liquidity2', 'remove_liquidity_by_range', 'remove_liquidity_by_range2', 'remove_all_liquidity'].map(dlmmRemove),
    { ix: 'claim_fee', action: CLAIM, sender: 'sender', tokens: ['user_token_x', 'user_token_y'], dlmmPosition: 'position' },
    { ix: 'claim_fee2', action: CLAIM, sender: 'sender', tokens: ['user_token_x', 'user_token_y'], dlmmPosition: 'position' },
    { ix: 'claim_reward', action: CLAIM, sender: 'sender', tokens: ['user_token_account'], dlmmPosition: 'position' },
    { ix: 'claim_reward2', action: CLAIM, sender: 'sender', tokens: ['user_token_account'], dlmmPosition: 'position' },
    ...['close_position', 'close_position2', 'close_position_if_empty'].map(dlmmClose),
  ] },
  DAMM_V2: { idl: load('damm'), rules: [
    ...['swap', 'swap2'].map((ix) => ({ ix, action: SWAP, sender: 'payer', pool: 'pool', tokens: ['input_token_account', 'output_token_account'], none: ['referral_token_account'] })),
    { ix: 'create_position', action: POS, wallet: ['owner'], payer: ['payer'], pool: 'pool' },
    // The pool address must already be listed, because this deposits vault funds at a price the caller picks.
    { ix: 'initialize_customizable_pool', action: LAUNCH, wallet: ['creator', 'payer'], pool: 'pool', tokens: ['payer_token_a', 'payer_token_b'] },
    { ix: 'add_liquidity', action: ADD, sender: 'signer', pool: 'pool', tokens: ['token_a_account', 'token_b_account', 'position_nft_account'] },
    ...['remove_liquidity', 'remove_all_liquidity'].map((ix) => ({ ix, action: REMOVE, sender: 'signer', tokens: ['token_a_account', 'token_b_account', 'position_nft_account'] })),
    { ix: 'claim_position_fee', action: CLAIM, sender: 'signer', tokens: ['token_a_account', 'token_b_account', 'position_nft_account'] },
    { ix: 'claim_reward', action: CLAIM, sender: 'signer', tokens: ['user_token_account', 'position_nft_account'], zeroArgs: ['skip_reward'] },
    { ix: 'close_position', action: POS, sender: 'owner', wallet: ['rent_receiver'], tokens: ['position_nft_account'], burned: ['position_nft_account'], dammPosition: 'position' },
  ] },
  DBC: { idl: load('dbc'), rules: [
    ...['swap', 'swap2'].map(dbcSwap),
    ...['initialize_virtual_pool_with_spl_token', 'initialize_virtual_pool_with_token2022'].map(dbcLaunch),
    ...['claim_creator_trading_fee', 'claim_creator_trading_fee2'].map((ix) => dbcClaim(ix, 'creator')),
    ...['claim_trading_fee', 'claim_trading_fee2'].map((ix) => dbcClaim(ix, 'fee_claimer')),
    { ix: 'creator_withdraw_surplus', action: CLAIM, sender: 'creator', tokens: ['token_quote_account'] },
    { ix: 'partner_withdraw_surplus', action: CLAIM, sender: 'fee_claimer', tokens: ['token_quote_account'] },
    { ix: 'withdraw_leftover', action: CLAIM, wallet: ['leftover_receiver'], tokens: ['token_base_account'] },
  ] },
};

const out = [];
/** Data offsets that must be zero, from flat instruction args or from fields of a params struct. */
function zeroOffsets(idl, ix, r) {
  const size = sizeOf(idl);
  const offsets = [];
  for (const name of r.zeroArgs ?? []) {
    let offset = ANCHOR_DISC;
    for (const arg of ix.args) {
      if (arg.name === name) { offsets.push(offset); break; }
      offset += size(arg.type);
    }
    if (!offsets.length) throw new Error(`${ix.name}: no arg ${name}`);
  }
  for (const name of r.zeroParams ?? []) offsets.push(offsetOf(idl, 'RebalanceLiquidityParams', name));
  return offsets;
}
const json = {};
for (const [target, { idl, rules }] of Object.entries(TARGETS)) {
  json[target] = { programId: idl.address, instructions: {} };
  for (const r of rules) {
    const ix = idl.instructions.find((i) => i.name === r.ix);
    if (!ix) throw new Error(`${target}: no instruction ${r.ix}`);
    const idx = (name) => {
      const i = ix.accounts.findIndex((a) => a.name === name);
      if (i < 0) throw new Error(`${target}.${r.ix}: no account ${name}`);
      return i;
    };
    const expected = [...createHash('sha256').update(`global:${r.ix}`).digest().subarray(0, 8)];
    const disc = ix.discriminator ?? expected;
    if (String(disc) !== String(expected)) throw new Error(`${target}.${r.ix}: unexpected discriminator`);
    const list = (names = []) => `&[${names.map(idx).join(', ')}]`;
    const opt = (name) => (name ? `Some(${idx(name)})` : 'None');
    for (const n of r.none ?? []) if (!ix.accounts[idx(n)].optional) throw new Error(`${target}.${r.ix}: ${n} is not optional`);
    out.push(`    // ${target}.${r.ix}
    Rule { target: ${target}, disc: [${disc.join(', ')}], action: ${r.action}, sender: ${opt(r.sender)}, pool: ${opt(r.pool)}, tokens: ${list(r.tokens)}, wallet: ${list(r.wallet)}, none: ${list(r.none)}, burned: ${list(r.burned)}, payer: ${list(r.payer)}, dlmm_position: ${opt(r.dlmmPosition)}, dbc_config: ${opt(r.dbcConfig)}, no_removes: ${Boolean(r.noRemoves)}, zero_data: &[${zeroOffsets(idl, ix, r).join(', ')}], fresh: ${list(r.fresh)}, damm_position: ${opt(r.dammPosition)} },`);
    json[target].instructions[r.ix] = { disc, action: r.action, accounts: ix.accounts.map((a) => a.name) };
  }
}

const dbcIdl = TARGETS.DBC.idl, dlmmIdl = TARGETS.DLMM.idl, dammIdl = TARGETS.DAMM_V2.idl;
const dammRewards = offsetOf(dammIdl, 'Position', 'reward_infos');
const rewardSize = sizeOf(dammIdl)({ defined: { name: 'UserRewardInfo' } });
const rewardPending = offsetOf(dammIdl, 'UserRewardInfo', 'reward_pendings') - ANCHOR_DISC;
const dammPending = [offsetOf(dammIdl, 'Position', 'fee_a_pending'), offsetOf(dammIdl, 'Position', 'fee_b_pending'), dammRewards + rewardPending, dammRewards + rewardSize + rewardPending];
const configDisc = dbcIdl.accounts.find((a) => a.name === 'PoolConfig').discriminator;

const rust = `// @generated by scripts/gen-rules.mjs from idl/meteora/*.json. Do not edit by hand.
use anchor_lang::prelude::*;
use anchor_lang::pubkey;

pub const DLMM: Pubkey = pubkey!("${TARGETS.DLMM.idl.address}");
pub const DAMM_V2: Pubkey = pubkey!("${TARGETS.DAMM_V2.idl.address}");
pub const DBC: Pubkey = pubkey!("${TARGETS.DBC.idl.address}");

pub const DBC_CONFIG_DISC: [u8; 8] = [${configDisc.join(', ')}];
pub const DBC_CONFIG_FEE_CLAIMER: usize = ${offsetOf(dbcIdl, 'PoolConfig', 'fee_claimer')};
pub const DBC_CONFIG_LEFTOVER_RECEIVER: usize = ${offsetOf(dbcIdl, 'PoolConfig', 'leftover_receiver')};
pub const DBC_CONFIG_POOL_CREATION_FEE: usize = ${offsetOf(dbcIdl, 'PoolConfig', 'pool_creation_fee')};
/// DAMM v2 position fields holding unclaimed fees and rewards. A close must not throw these away.
pub const DAMM_POSITION_PENDING: [usize; 4] = [${dammPending.join(', ')}];
/// Byte offset of the removes vector length in rebalance_liquidity data.
pub const REBALANCE_REMOVES_LEN: usize = ${offsetOf(dlmmIdl, 'RebalanceLiquidityParams', 'removes')};

pub const SWAP: u8 = 1 << 0;
pub const ADD_LIQUIDITY: u8 = 1 << 1;
pub const REMOVE_LIQUIDITY: u8 = 1 << 2;
pub const CLAIM: u8 = 1 << 3;
pub const POSITION: u8 = 1 << 4;
/// Create tokens and pools. Off unless the owner turns it on.
pub const LAUNCH: u8 = 1 << 5;
pub const ALL_ACTIONS: u8 = SWAP | ADD_LIQUIDITY | REMOVE_LIQUIDITY | CLAIM | POSITION | LAUNCH;

/// One callable Meteora instruction and the account checks it needs.
pub struct Rule {
    pub target: Pubkey,
    pub disc: [u8; 8],
    pub action: u8,
    /// Account that signs for the funds. Must be the vault wallet.
    pub sender: Option<u8>,
    /// Pool account checked against the allowlist. Exits have none, so funds can always leave a delisted pool.
    pub pool: Option<u8>,
    /// Token accounts that must be owned by the vault wallet.
    pub tokens: &'static [u8],
    /// Accounts that must be the vault wallet itself.
    pub wallet: &'static [u8],
    /// Optional fee recipients that must stay empty.
    pub none: &'static [u8],
    /// Position NFT accounts this instruction burns and closes. They must hold exactly one token and are not metered.
    pub burned: &'static [u8],
    /// Rent payer slots. The wallet may sit here and its lamports are metered, or the agent key may pay instead.
    pub payer: &'static [u8],
    /// DLMM position whose stored owner must be the vault wallet.
    pub dlmm_position: Option<u8>,
    /// DBC config that must pay fees and leftovers to the wallet and charge no pool creation fee.
    pub dbc_config: Option<u8>,
    /// A rebalance that may only add. Removing inside one would move position value without touching a token balance.
    pub no_removes: bool,
    /// Data offsets that must be zero: arguments that would change who gets value.
    pub zero_data: &'static [u16],
    /// Accounts that must not exist yet, so the caller cannot act on one someone else prepared.
    pub fresh: &'static [u8],
    /// DAMM v2 position that must hold no unclaimed fees or rewards.
    pub damm_position: Option<u8>,
}

pub const RULES: &[Rule] = &[
${out.join('\n')}
];

pub fn find_rule(target: &Pubkey, disc: &[u8]) -> Option<&'static Rule> {
    RULES.iter().find(|r| r.target == *target && r.disc == disc)
}
`;
fs.writeFileSync(new URL('../programs/metboi-agentic/src/rules.rs', import.meta.url), rust);
fs.writeFileSync(new URL('../sdk/rules.json', import.meta.url), JSON.stringify(json, null, 1));
console.log(`generated ${out.length} rules`);
