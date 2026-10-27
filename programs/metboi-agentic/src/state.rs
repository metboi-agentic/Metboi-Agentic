use crate::error::VaultError;
use anchor_lang::prelude::*;

pub const VAULT_SEED: &[u8] = b"vault";
pub const WALLET_SEED: &[u8] = b"wallet";
pub const MAX_POOLS: usize = 16;
pub const MAX_BUDGETS: usize = 8;
/// One more than 24, so spend always stays counted for at least a full 24 hours.
pub const HOURS: usize = 25;
pub const SECONDS_PER_HOUR: i64 = 3_600;

/// A spend limit with two caps.
/// The trade cap counts everything spent in one slot, so several calls in one transaction cannot get around it.
/// The daily cap sums hourly buckets, so spend stays counted for 24 to 25 hours and it rolls instead of resetting.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct Meter {
    pub tx_cap: u64,
    pub daily_cap: u64,
    pub slot_spent: u64,
    pub last_slot: u64,
    pub last_hour: i64,
    pub buckets: [u64; HOURS],
}

impl Meter {
    pub const SIZE: usize = 8 * 5 + 8 * HOURS;

    fn rotate(&mut self, hour: i64) {
        // A clock that steps back keeps every bucket, so it can never refresh a spent budget.
        if hour <= self.last_hour {
            return;
        }
        let elapsed = hour - self.last_hour;
        if elapsed >= HOURS as i64 {
            self.buckets = [0; HOURS];
        } else {
            for step in 1..=elapsed {
                self.buckets[((self.last_hour + step) as usize) % HOURS] = 0;
            }
        }
        self.last_hour = hour;
    }

    pub fn charge(&mut self, amount: u64, now: i64, slot: u64) -> Result<()> {
        if slot != self.last_slot {
            self.slot_spent = 0;
            self.last_slot = slot;
        }
        let in_slot = self.slot_spent.checked_add(amount).ok_or(VaultError::TxCapExceeded)?;
        require!(in_slot <= self.tx_cap, VaultError::TxCapExceeded);
        self.slot_spent = in_slot;

        let hour = now / SECONDS_PER_HOUR;
        self.rotate(hour);
        let mut total = amount;
        for bucket in self.buckets {
            total = total.checked_add(bucket).ok_or(VaultError::DailyCapExceeded)?;
        }
        require!(total <= self.daily_cap, VaultError::DailyCapExceeded);
        let index = (hour as usize) % HOURS;
        self.buckets[index] = self.buckets[index].checked_add(amount).ok_or(VaultError::DailyCapExceeded)?;
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct Budget {
    pub mint: Pubkey,
    pub meter: Meter,
}

/// Owner-supplied limits. Spent counters are kept by the program.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CapInput {
    pub mint: Pubkey,
    pub tx_cap: u64,
    pub daily_cap: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PolicyInput {
    pub actions: u8,
    pub lamport_tx_cap: u64,
    pub lamport_daily_cap: u64,
    pub pools: Vec<Pubkey>,
    pub budgets: Vec<CapInput>,
}

#[account]
pub struct Vault {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub id: u64,
    pub bump: u8,
    pub wallet_bump: u8,
    pub paused: bool,
    pub actions: u8,
    /// Unix seconds. Zero means the agent key does not expire.
    pub agent_expires_at: i64,
    pub lamports: Meter,
    pub pools: Vec<Pubkey>,
    pub budgets: Vec<Budget>,
}

impl Vault {
    pub const SIZE: usize = 8
        + 32 + 32 + 8 + 1 + 1 + 1 + 1 + 8
        + Meter::SIZE
        + 4 + 32 * MAX_POOLS
        + 4 + (32 + Meter::SIZE) * MAX_BUDGETS;

    /// Replaces the policy. Counters survive for every mint that stays listed.
    /// Removing a mint and adding it back later starts its counters fresh.
    pub fn apply_policy(&mut self, input: PolicyInput) -> Result<()> {
        require!(input.actions & !crate::rules::ALL_ACTIONS == 0, VaultError::InvalidPolicy);
        require!(input.pools.len() <= MAX_POOLS, VaultError::InvalidPolicy);
        require!(input.budgets.len() <= MAX_BUDGETS, VaultError::InvalidPolicy);
        require!(input.lamport_tx_cap <= input.lamport_daily_cap, VaultError::InvalidPolicy);
        for (i, pool) in input.pools.iter().enumerate() {
            require!(!input.pools[..i].contains(pool), VaultError::InvalidPolicy);
        }
        let mut budgets = Vec::with_capacity(input.budgets.len());
        for (i, cap) in input.budgets.iter().enumerate() {
            require!(cap.tx_cap <= cap.daily_cap, VaultError::InvalidPolicy);
            require!(
                !input.budgets[..i].iter().any(|other| other.mint == cap.mint),
                VaultError::InvalidPolicy
            );
            let previous = self.budgets.iter().find(|b| b.mint == cap.mint).map(|b| b.meter).unwrap_or_default();
            budgets.push(Budget {
                mint: cap.mint,
                meter: Meter { tx_cap: cap.tx_cap, daily_cap: cap.daily_cap, ..previous },
            });
        }
        self.actions = input.actions;
        self.lamports.tx_cap = input.lamport_tx_cap;
        self.lamports.daily_cap = input.lamport_daily_cap;
        self.pools = input.pools;
        self.budgets = budgets;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: i64 = SECONDS_PER_HOUR;
    /// One second before an hour boundary, the worst case for a bucketed window.
    const START: i64 = 500_000 * HOUR + HOUR - 1;

    fn meter(tx_cap: u64, daily_cap: u64) -> Meter {
        Meter { tx_cap, daily_cap, ..Meter::default() }
    }

    #[test]
    fn one_slot_cannot_exceed_the_trade_cap_in_parts() {
        let mut m = meter(100, 1_000);
        m.charge(60, START, 5).unwrap();
        assert!(m.charge(60, START, 5).is_err());
        m.charge(60, START, 6).unwrap();
    }

    #[test]
    fn spend_stays_counted_for_a_full_24_hours_from_any_second() {
        let mut m = meter(1_000, 1_000);
        m.charge(1_000, START, 1).unwrap();
        assert!(m.charge(1, START + 1, 2).is_err(), "the next hour");
        assert!(m.charge(1, START + 24 * HOUR, 3).is_err(), "exactly 24 hours later");
    }

    #[test]
    fn spend_expires_within_25_hours() {
        let mut m = meter(1_000, 1_000);
        m.charge(1_000, START, 1).unwrap();
        m.charge(1_000, START + 25 * HOUR, 2).unwrap();
    }

    #[test]
    fn the_cap_holds_over_any_day_for_spend_spread_across_hours() {
        let mut m = meter(1_000, 1_000);
        m.charge(400, START, 1).unwrap();
        m.charge(600, START + 2 * HOUR, 2).unwrap();
        assert!(m.charge(400, START + 3 * HOUR, 3).is_err());
        m.charge(400, START + 25 * HOUR, 4).unwrap();
        assert!(m.charge(1, START + 25 * HOUR, 5).is_err());
    }

    #[test]
    fn a_long_gap_clears_everything() {
        let mut m = meter(1_000, 1_000);
        m.charge(1_000, START, 1).unwrap();
        m.charge(1_000, START + 500 * HOUR, 2).unwrap();
    }

    #[test]
    fn an_earlier_clock_does_not_refresh_a_spent_budget() {
        let mut m = meter(1_000, 1_000);
        m.charge(1_000, START, 1).unwrap();
        assert!(m.charge(1, START - HOUR, 2).is_err());
        assert!(m.charge(1, START, 3).is_err());
    }
}
