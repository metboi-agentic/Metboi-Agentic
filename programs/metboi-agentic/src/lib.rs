//! Metboi Agentic: a wallet an AI agent can trade from but cannot empty.
//!
//! The owner funds a system-owned wallet PDA. The agent key can only make that PDA sign
//! allowlisted Meteora instructions, inside limits this program checks on every call.
//! The owner alone can change limits, pause the agent, and withdraw.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_lang::system_program;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

pub mod error;
pub mod rules;
pub mod state;

use error::VaultError;
use rules::{find_rule, Rule};
use state::*;

declare_id!("9sKnrstB16ZL2Yb8mLHXHcyeWffeZyJU17m9UJa6G8oT");

const TOKEN_ACCOUNT_LEN: usize = 165;
const TOKEN_2022_TYPE_OFFSET: usize = 165;
const TOKEN_2022_TYPE_ACCOUNT: u8 = 2;
const TOKEN_2022_TYPE_MINT: u8 = 1;
const TLV_HEADER: usize = 4;
const EXTENSION_TRANSFER_HOOK: u16 = 14;
const TRANSFER_CHECKED: u8 = 12;
const DLMM_POSITION_OWNER_OFFSET: usize = 8 + 32;
const DLMM_POSITION_OPERATOR_OFFSET: usize = 7960;
const DLMM_POSITION_LOCK_OFFSET: usize = 7992;
const DLMM_POSITION_FEE_OWNER_OFFSET: usize = 8001;

#[program]
pub mod metboi_agentic {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        id: u64,
        agent: Pubkey,
        agent_expires_at: i64,
        policy: PolicyInput,
    ) -> Result<()> {
        require_keys_neq!(agent, ctx.accounts.owner.key(), VaultError::AgentIsOwner);
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.agent = agent;
        vault.id = id;
        vault.bump = ctx.bumps.vault;
        vault.wallet_bump = ctx.bumps.wallet;
        vault.paused = false;
        vault.agent_expires_at = agent_expires_at;
        vault.apply_policy(policy)
    }

    pub fn update_policy(ctx: Context<OwnerOnly>, policy: PolicyInput) -> Result<()> {
        ctx.accounts.vault.apply_policy(policy)
    }

    pub fn set_agent(ctx: Context<OwnerOnly>, agent: Pubkey, agent_expires_at: i64) -> Result<()> {
        require_keys_neq!(agent, ctx.accounts.owner.key(), VaultError::AgentIsOwner);
        let vault = &mut ctx.accounts.vault;
        vault.agent = agent;
        vault.agent_expires_at = agent_expires_at;
        Ok(())
    }

    pub fn set_paused(ctx: Context<OwnerOnly>, paused: bool) -> Result<()> {
        ctx.accounts.vault.paused = paused;
        Ok(())
    }

    /// Withdraws tokens. remaining_accounts carries the extra accounts a transfer hook needs, if the mint has one.
    pub fn withdraw_token<'info>(ctx: Context<'info, WithdrawToken<'info>>, amount: u64) -> Result<()> {
        let vault_key = ctx.accounts.vault.key();
        let seeds: &[&[u8]] = &[WALLET_SEED, vault_key.as_ref(), &[ctx.accounts.vault.wallet_bump]];
        let mut data = Vec::with_capacity(10);
        data.push(TRANSFER_CHECKED);
        data.extend_from_slice(&amount.to_le_bytes());
        data.push(ctx.accounts.mint.decimals);
        let mut metas = vec![
            AccountMeta::new(ctx.accounts.from.key(), false),
            AccountMeta::new_readonly(ctx.accounts.mint.key(), false),
            AccountMeta::new(ctx.accounts.to.key(), false),
            AccountMeta::new_readonly(ctx.accounts.wallet.key(), true),
        ];
        let mut infos = vec![
            ctx.accounts.from.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.to.to_account_info(),
            ctx.accounts.wallet.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ];
        for extra in ctx.remaining_accounts {
            metas.push(AccountMeta { pubkey: extra.key(), is_signer: false, is_writable: extra.is_writable });
            infos.push(extra.clone());
        }
        invoke_signed(&Instruction { program_id: ctx.accounts.token_program.key(), accounts: metas, data }, &infos, &[seeds])?;
        Ok(())
    }

    /// Lets the owner run any instruction as the wallet, so funds never depend on the agent rule table.
    pub fn owner_execute<'info>(ctx: Context<'info, OwnerExecute<'info>>, data: Vec<u8>) -> Result<()> {
        let target = ctx.accounts.target_program.key();
        require_keys_neq!(target, crate::ID, VaultError::TargetNotAllowed);
        let wallet = ctx.accounts.wallet.key();
        let vault_key = ctx.accounts.vault.key();
        let seeds: &[&[u8]] = &[WALLET_SEED, vault_key.as_ref(), &[ctx.accounts.vault.wallet_bump]];
        call_as_wallet(target, data, ctx.remaining_accounts, ctx.accounts.target_program.to_account_info(), &wallet, seeds)?;
        require_wallet_intact(&ctx.accounts.wallet.to_account_info())
    }

    pub fn withdraw_sol(ctx: Context<WithdrawSol>, lamports: u64) -> Result<()> {
        let vault_key = ctx.accounts.vault.key();
        let seeds: &[&[u8]] = &[WALLET_SEED, vault_key.as_ref(), &[ctx.accounts.vault.wallet_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.wallet.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                },
                &[seeds],
            ),
            lamports,
        )
    }

    /// Runs one Meteora instruction for the agent, with the wallet PDA as signer.
    /// remaining_accounts is the target instruction's account list, in order.
    pub fn execute<'info>(ctx: Context<'info, Execute<'info>>, data: Vec<u8>) -> Result<()> {
        let authority = ctx.accounts.authority.key();
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let wallet = ctx.accounts.wallet.key();
        let target = ctx.accounts.target_program.key();
        let accounts = ctx.remaining_accounts;

        {
            let vault = &ctx.accounts.vault;
            require_keys_eq!(authority, vault.agent, VaultError::Unauthorized);
            require!(!vault.paused, VaultError::Paused);
            require!(vault.agent_expires_at == 0 || now < vault.agent_expires_at, VaultError::AgentExpired);
        }

        require!(data.len() >= 8, VaultError::MalformedInstruction);
        let rule = find_rule(&target, &data[..8]).ok_or(VaultError::InstructionNotAllowed)?;
        check_accounts(rule, accounts, &wallet, &target)?;
        check_data(rule, &data)?;
        {
            let vault = &ctx.accounts.vault;
            require!(vault.actions & rule.action != 0, VaultError::ActionDisabled);
            if let Some(index) = rule.pool {
                let pool = account_at(accounts, index)?.key();
                require!(vault.pools.contains(&pool), VaultError::PoolNotAllowed);
            }
        }

        let tokens_before = snapshot_tokens(accounts, &wallet, rule.burned)?;
        let lamports_before = ctx.accounts.wallet.lamports();

        let vault_key = ctx.accounts.vault.key();
        let seeds: &[&[u8]] = &[WALLET_SEED, vault_key.as_ref(), &[ctx.accounts.vault.wallet_bump]];
        call_as_wallet(target, data, accounts, ctx.accounts.target_program.to_account_info(), &wallet, seeds)?;
        require_wallet_intact(&ctx.accounts.wallet.to_account_info())?;

        // Every token or lamport that left is charged to the agent.
        let lamports_after = ctx.accounts.wallet.lamports();
        let vault = &mut ctx.accounts.vault;
        for (index, mint, before) in &tokens_before {
            let after = token_amount(&accounts[*index])?;
            if after < *before {
                let budget = vault.budgets.iter_mut().find(|b| b.mint == *mint).ok_or(VaultError::MintNotAllowed)?;
                budget.meter.charge(before - after, now, clock.slot)?;
            }
        }
        if lamports_after < lamports_before {
            vault.lamports.charge(lamports_before - lamports_after, now, clock.slot)?;
        }

        emit!(Executed { vault: vault_key, authority, target, action: rule.action });
        Ok(())
    }
}

fn call_as_wallet<'info>(
    target: Pubkey,
    data: Vec<u8>,
    accounts: &[AccountInfo<'info>],
    target_info: AccountInfo<'info>,
    wallet: &Pubkey,
    seeds: &[&[u8]],
) -> Result<()> {
    let metas = accounts
        .iter()
        .map(|a| AccountMeta {
            pubkey: a.key(),
            is_signer: a.is_signer || a.key() == *wallet,
            is_writable: a.is_writable,
        })
        .collect();
    let mut infos = accounts.to_vec();
    infos.push(target_info);
    invoke_signed(&Instruction { program_id: target, accounts: metas, data }, &infos, &[seeds])?;
    Ok(())
}

/// A CPI signed by the wallet must never leave it owned by another program or holding data.
fn require_wallet_intact(wallet: &AccountInfo) -> Result<()> {
    require!(*wallet.owner == system_program::ID && wallet.data_is_empty(), VaultError::WalletCorrupted);
    Ok(())
}

/// Checks that depend on the instruction arguments.
fn check_data(rule: &Rule, data: &[u8]) -> Result<()> {
    if rule.no_removes {
        let bytes = data
            .get(rules::REBALANCE_REMOVES_LEN..rules::REBALANCE_REMOVES_LEN + 4)
            .ok_or(VaultError::MalformedInstruction)?;
        require!(bytes.iter().all(|b| *b == 0), VaultError::RebalanceRemoveNotAllowed);
    }
    for offset in rule.zero_data {
        let byte = data.get(*offset as usize).ok_or(VaultError::MalformedInstruction)?;
        require!(*byte == 0, VaultError::ArgumentNotAllowed);
    }
    Ok(())
}

/// True for a Token-2022 mint whose transfer hook extension names a program.
fn has_transfer_hook(account: &AccountInfo) -> Result<bool> {
    if *account.owner != anchor_spl::token_2022::ID {
        return Ok(false);
    }
    let data = account.try_borrow_data()?;
    if data.len() <= TOKEN_2022_TYPE_OFFSET || data[TOKEN_2022_TYPE_OFFSET] != TOKEN_2022_TYPE_MINT {
        return Ok(false);
    }
    let mut at = TOKEN_2022_TYPE_OFFSET + 1;
    while at + TLV_HEADER <= data.len() {
        let kind = u16::from_le_bytes([data[at], data[at + 1]]);
        let len = u16::from_le_bytes([data[at + 2], data[at + 3]]) as usize;
        if kind == 0 {
            break;
        }
        let value = at + TLV_HEADER;
        if kind == EXTENSION_TRANSFER_HOOK {
            let program = data.get(value + 32..value + 64).ok_or(VaultError::MalformedInstruction)?;
            return Ok(program.iter().any(|b| *b != 0));
        }
        at = value + len;
    }
    Ok(false)
}

fn check_dbc_config(config: &AccountInfo, wallet: &Pubkey) -> Result<()> {
    require_keys_eq!(*config.owner, rules::DBC, VaultError::ConfigNotAllowed);
    let data = config.try_borrow_data()?;
    let field = |offset: usize, len: usize| -> Result<&[u8]> {
        data.get(offset..offset + len).ok_or_else(|| error!(VaultError::ConfigNotAllowed))
    };
    require!(field(0, 8)? == rules::DBC_CONFIG_DISC, VaultError::ConfigNotAllowed);
    require!(field(rules::DBC_CONFIG_FEE_CLAIMER, 32)? == wallet.as_ref(), VaultError::ConfigNotAllowed);
    require!(field(rules::DBC_CONFIG_LEFTOVER_RECEIVER, 32)? == wallet.as_ref(), VaultError::ConfigNotAllowed);
    require!(field(rules::DBC_CONFIG_POOL_CREATION_FEE, 8)?.iter().all(|b| *b == 0), VaultError::ConfigNotAllowed);
    Ok(())
}

fn account_at<'a, 'info>(accounts: &'a [AccountInfo<'info>], index: u8) -> Result<&'a AccountInfo<'info>> {
    accounts.get(index as usize).ok_or_else(|| error!(VaultError::MalformedInstruction))
}

/// Rejects any account list that could route value away from the wallet.
fn check_accounts(rule: &Rule, accounts: &[AccountInfo], wallet: &Pubkey, target: &Pubkey) -> Result<()> {
    for (index, account) in accounts.iter().enumerate() {
        if account.key() == *wallet {
            let named = rule.sender.map(usize::from) == Some(index)
                || rule.wallet.iter().any(|i| *i as usize == index)
                || rule.payer.iter().any(|i| *i as usize == index);
            require!(named, VaultError::WalletSlotNotAllowed);
        }
        require!(!has_transfer_hook(account)?, VaultError::TransferHookNotAllowed);
    }
    for index in rule.fresh {
        require!(account_at(accounts, *index)?.data_is_empty(), VaultError::AccountMustBeNew);
    }
    if let Some(index) = rule.damm_position {
        let position = account_at(accounts, index)?;
        require_keys_eq!(*position.owner, *target, VaultError::PendingFeesNotClaimed);
        let data = position.try_borrow_data()?;
        for offset in rules::DAMM_POSITION_PENDING {
            let pending = data.get(offset..offset + 8).ok_or(VaultError::PendingFeesNotClaimed)?;
            require!(pending.iter().all(|b| *b == 0), VaultError::PendingFeesNotClaimed);
        }
    }
    if let Some(index) = rule.dbc_config {
        check_dbc_config(account_at(accounts, index)?, wallet)?;
    }
    if let Some(index) = rule.sender {
        require_keys_eq!(account_at(accounts, index)?.key(), *wallet, VaultError::SenderNotWallet);
    }
    for index in rule.wallet {
        require_keys_eq!(account_at(accounts, *index)?.key(), *wallet, VaultError::AccountNotOwnedByWallet);
    }
    for index in rule.none {
        require_keys_eq!(account_at(accounts, *index)?.key(), *target, VaultError::FeeRecipientNotAllowed);
    }
    for index in rule.tokens {
        let parsed = parse_token_account(account_at(accounts, *index)?)?;
        let (_, owner, _) = parsed.ok_or(VaultError::AccountNotOwnedByWallet)?;
        require_keys_eq!(owner, *wallet, VaultError::AccountNotOwnedByWallet);
    }
    if let Some(index) = rule.dlmm_position {
        let position = account_at(accounts, index)?;
        require_keys_eq!(*position.owner, *target, VaultError::PositionNotOwnedByWallet);
        let data = position.try_borrow_data()?;
        let stored = data
            .get(DLMM_POSITION_OWNER_OFFSET..DLMM_POSITION_OWNER_OFFSET + 32)
            .ok_or(VaultError::PositionNotOwnedByWallet)?;
        require!(stored == wallet.as_ref(), VaultError::PositionNotOwnedByWallet);
        // New funds only go into a position nobody else can act on. Exits stay open.
        if rule.action == rules::ADD_LIQUIDITY {
            let field = |offset: usize, len: usize| -> Result<&[u8]> {
                data.get(offset..offset + len).ok_or_else(|| error!(VaultError::PositionControlledByOther))
            };
            let clear = |bytes: &[u8]| bytes.iter().all(|b| *b == 0) || bytes == wallet.as_ref();
            require!(clear(field(DLMM_POSITION_OPERATOR_OFFSET, 32)?), VaultError::PositionControlledByOther);
            require!(clear(field(DLMM_POSITION_FEE_OWNER_OFFSET, 32)?), VaultError::PositionControlledByOther);
            require!(field(DLMM_POSITION_LOCK_OFFSET, 8)?.iter().all(|b| *b == 0), VaultError::PositionControlledByOther);
        }
    }
    Ok(())
}

/// Returns (mint, owner, amount) when the account is an SPL or Token-2022 token account.
fn parse_token_account(account: &AccountInfo) -> Result<Option<(Pubkey, Pubkey, u64)>> {
    let is_token_program =
        *account.owner == anchor_spl::token::ID || *account.owner == anchor_spl::token_2022::ID;
    if !is_token_program {
        return Ok(None);
    }
    let data = account.try_borrow_data()?;
    if data.len() < TOKEN_ACCOUNT_LEN {
        return Ok(None);
    }
    if data.len() > TOKEN_ACCOUNT_LEN && data[TOKEN_2022_TYPE_OFFSET] != TOKEN_2022_TYPE_ACCOUNT {
        return Ok(None);
    }
    let read_key = |range: std::ops::Range<usize>| -> Result<Pubkey> {
        Pubkey::try_from(&data[range]).map_err(|_| error!(VaultError::MalformedInstruction))
    };
    let amount = u64::from_le_bytes(
        data[64..72].try_into().map_err(|_| error!(VaultError::MalformedInstruction))?,
    );
    Ok(Some((read_key(0..32)?, read_key(32..64)?, amount)))
}

fn token_amount(account: &AccountInfo) -> Result<u64> {
    let (_, _, amount) = parse_token_account(account)?.ok_or(VaultError::MalformedInstruction)?;
    Ok(amount)
}

/// Records every wallet token account in the list, once each, so any outflow gets metered.
/// A position NFT that the instruction burns is skipped, but only when it holds exactly one token.
fn snapshot_tokens(accounts: &[AccountInfo], wallet: &Pubkey, burned: &[u8]) -> Result<Vec<(usize, Pubkey, u64)>> {
    let mut found: Vec<(usize, Pubkey, u64)> = Vec::new();
    for (index, account) in accounts.iter().enumerate() {
        if burned.iter().any(|b| *b as usize == index) {
            require!(token_amount(account)? == 1, VaultError::NotAPositionNft);
            continue;
        }
        if accounts[..index].iter().any(|seen| seen.key() == account.key()) {
            continue;
        }
        if let Some((mint, owner, amount)) = parse_token_account(account)? {
            if owner == *wallet {
                found.push((index, mint, amount));
            }
        }
    }
    Ok(found)
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = Vault::SIZE,
        seeds = [VAULT_SEED, owner.key().as_ref(), &id.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    /// CHECK: seeds only. This system-owned PDA holds the funds.
    #[account(seeds = [WALLET_SEED, vault.key().as_ref()], bump)]
    pub wallet: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct WithdrawToken<'info> {
    pub owner: Signer<'info>,
    #[account(has_one = owner @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    /// CHECK: seeds only.
    #[account(seeds = [WALLET_SEED, vault.key().as_ref()], bump = vault.wallet_bump)]
    pub wallet: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = wallet, token::token_program = token_program)]
    pub from: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub to: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawSol<'info> {
    pub owner: Signer<'info>,
    #[account(has_one = owner @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [WALLET_SEED, vault.key().as_ref()], bump = vault.wallet_bump)]
    pub wallet: SystemAccount<'info>,
    /// CHECK: the owner picks any destination.
    #[account(mut)]
    pub to: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerExecute<'info> {
    pub owner: Signer<'info>,
    #[account(has_one = owner @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [WALLET_SEED, vault.key().as_ref()], bump = vault.wallet_bump)]
    pub wallet: SystemAccount<'info>,
    /// CHECK: the owner picks any program except this one.
    pub target_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [WALLET_SEED, vault.key().as_ref()], bump = vault.wallet_bump)]
    pub wallet: SystemAccount<'info>,
    /// CHECK: find_rule only accepts the Meteora programs in rules.rs.
    pub target_program: UncheckedAccount<'info>,
}

#[event]
pub struct Executed {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub target: Pubkey,
    pub action: u8,
}
