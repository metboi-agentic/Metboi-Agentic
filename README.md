# Metboi Agentic

A wallet for AI agents on Meteora. The agent can trade and provide liquidity inside limits the owner sets. It cannot withdraw, send funds elsewhere, or change those limits, because a Solana program enforces them on-chain instead of a vendor service.

The on-chain program is deployed on mainnet-beta at `9sKnrstB16ZL2Yb8mLHXHcyeWffeZyJU17m9UJa6G8oT`. It has had internal reviews with AI tools and **no independent audit**. One key can upgrade it. Use only funds you can afford to lose.

## How it works

- **Vault program** (`programs/metboi-agentic`) — an Anchor program that holds the funds and checks every instruction against the owner's policy: per-token budgets, allowed venues, allowed actions, and expiry. The agent key can only submit actions that pass.
- **SDK** (`sdk/`) — builds instructions and reads vault state.
- **CLI** (`bin/metboi.mjs`) — one command per action, JSON on stdout, `--broadcast` to actually send. Without it, every action is a dry run.
- **MCP server** (`bin/mcp.mjs`) — the same surface over the Model Context Protocol, so an agent runtime can call it as tools.
- **Agent skill** (`skills/metboi-agentic`) — instructions for an agent using the CLI, including the command table and the rules it must follow.
- **Owner console** (`console-src/`, served at `/console` by `server/`) — read-only view of a vault, plus a read/simulate RPC gateway.
- **Site** (`web/`) — static page, served at [metboi.com](https://metboi.com).

## Use it

```bash
npm install -g https://metboi.com/metboi-0.1.1.tgz
metboi status
```

The URL is pinned to the version, and `https://metboi.com/metboi-0.1.1.tgz.sha256` carries the checksum to compare against:
`e72604fa2a7d05a94b1f220612e54c8e6942f1784af8a73c60b72643a622e0a4`.

A vault has an owner key and an agent key. The owner creates the vault and sets the policy; the agent only gets its own key. Keep the owner key on a different machine or user account: both command sets ship in one package, so an agent with shell access can read any key file its account can reach.

Commands cover the three Meteora venues:

| Venue | What the agent can do |
|---|---|
| DLMM | pool info, quote, swap, positions, open/add/remove/close, claim fees and rewards, extend/shrink/rebalance a range, create a pool, limit orders |
| DAMM v2 | pool info, quote, swap, positions, open/add/remove/close, claim fees and rewards, create a pool |
| DBC | pool info, quote, buy and sell, create a launch config, launch a token, claim creator and partner fees, withdraw surplus and leftover tokens |

Every swap takes `--min-out`, and stops if the fresh floor is below it. Unknown flags, misspelled values and non-integer amounts are refused rather than guessed.

## Security status

`SECURITY-REVIEW.md` lists what was reviewed, what was fixed in 0.1.1, and what remains open. The short version:

- The on-chain program has not been through an independent review. That review should happen before the vault holds funds you could not afford to lose.
- Client findings were fixed in 0.1.1 and the fixes were read by a second reviewer.
- Limits stop an agent from leaving the policy. They do not stop bad trades inside it.
- Agent key SOL is not capped by the vault. Fund that key with only what you accept it spending.
- `npm audit` reports advisories through transitive dependencies of the Solana SDKs, not fixed upstream at versions those SDKs accept.

## Develop

```bash
pnpm install --ignore-scripts
anchor build
node --test --test-force-exit --test-concurrency=1 test/*.test.mjs
```

Tests run against a local fork of mainnet programs; `test/takeover.test.mjs` and `test/hardening.test.mjs` are the attack cases. `mainnet.json` and `devnet.json` record the deployed addresses and signatures.

## License

MIT. See `LICENSE` and `NOTICE`.
