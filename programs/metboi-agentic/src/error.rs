use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Signer is neither the owner nor the active agent")]
    Unauthorized,
    #[msg("Vault is paused")]
    Paused,
    #[msg("Agent key has expired")]
    AgentExpired,
    #[msg("Program or instruction is not allowed")]
    InstructionNotAllowed,
    #[msg("Action is disabled by policy")]
    ActionDisabled,
    #[msg("Pool is not on the allowlist")]
    PoolNotAllowed,
    #[msg("Instruction data or account list is malformed")]
    MalformedInstruction,
    #[msg("Signing account must be the vault wallet")]
    SenderNotWallet,
    #[msg("Funds would reach an account the vault wallet does not own")]
    AccountNotOwnedByWallet,
    #[msg("Fee recipient accounts must stay empty")]
    FeeRecipientNotAllowed,
    #[msg("Position is not owned by the vault wallet")]
    PositionNotOwnedByWallet,
    #[msg("Token has no spending budget")]
    MintNotAllowed,
    #[msg("Spend exceeds the per-trade cap, counted per slot")]
    TxCapExceeded,
    #[msg("Spend exceeds the rolling 24 hour cap")]
    DailyCapExceeded,
    #[msg("Policy has too many entries, duplicates, or inconsistent caps")]
    InvalidPolicy,
    #[msg("Agent must be a different key from the owner")]
    AgentIsOwner,
    #[msg("Burned account must hold exactly one position NFT")]
    NotAPositionNft,
    #[msg("Position has an operator, fee owner, or lock set by someone else")]
    PositionControlledByOther,
    #[msg("The vault wallet may only appear in the account slots a rule names")]
    WalletSlotNotAllowed,
    #[msg("The vault wallet must stay a system-owned account with no data")]
    WalletCorrupted,
    #[msg("Rebalancing may only add liquidity")]
    RebalanceRemoveNotAllowed,
    #[msg("Launch config must pay the vault wallet and charge no pool creation fee")]
    ConfigNotAllowed,
    #[msg("Mints with a transfer hook are not allowed")]
    TransferHookNotAllowed,
    #[msg("An instruction argument has a value the vault does not allow")]
    ArgumentNotAllowed,
    #[msg("This account must not exist yet")]
    AccountMustBeNew,
    #[msg("Claim fees and rewards before closing this position")]
    PendingFeesNotClaimed,
    #[msg("This program cannot call itself")]
    TargetNotAllowed,
}
