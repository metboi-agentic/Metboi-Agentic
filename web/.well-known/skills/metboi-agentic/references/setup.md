# Setup, for the owner

These steps are for the person who owns the vault. An agent should show them, not run them.

The console at https://metboi.com/console does steps 2 and 3 with a browser wallet, and has its own controls for limits, pools, pausing, and withdrawing. It cannot close open positions, so use the owner commands below for that.

## 1. Get the CLI

You need Node.js 20 or newer and your own Solana RPC URL.

```bash
npm install -g --ignore-scripts https://metboi.com/metboi-0.1.1.tgz
```

`--ignore-scripts` stops dependencies from running code during install, and the CLI works without those scripts. The tarball pins its whole dependency tree. To check the download first, compare it with `https://metboi.com/metboi-0.1.1.tgz.sha256`. That file comes from the same server, so it catches a damaged download, not a compromised server.

The same package holds owner and agent commands, so the owner key is what keeps them apart. Keep it on another machine or user account. An agent with shell access can read any key file that account can reach, and the wrapper's refusal of owner commands does not stop that.

The program has had internal reviews with AI tools and no independent audit, and one key can upgrade it. Use only funds you can afford to lose.

## 2. Create the vault

Generate a new key for the agent with `solana-keygen new -o agent.json`. Never reuse your main wallet. Then run this with your own key, on your own machine:

```bash
METBOI_RPC=<your RPC URL> METBOI_OWNER_KEY=<owner key path> metboi init --agent <agent public key> --policy policy.json --broadcast
```

An example `policy.json`:

```json
{
  "actions": 31,
  "lamportTxCap": "100000000",
  "lamportDailyCap": "300000000",
  "pools": ["<pool address>"],
  "budgets": [
    { "mint": "So11111111111111111111111111111111111111112", "txCap": "30000000", "dailyCap": "60000000" }
  ]
}
```

`actions` is a sum: swap and limit orders 1, add liquidity 2, remove liquidity 4, claim 8, positions 16, launching tokens and creating pools 32. Use 31 to allow everything except launching, or 63 for all. If you leave it out, it defaults to 31. A token with no budget cannot be spent.

`policy` replaces the whole policy, so list every pool each time. List a new pool here before the agent can trade it, including a token the agent just launched. Anyone can create a pool at an address you listed in advance, so inspect its fees and liquidity once it exists.

## 3. Fund it

`init` prints the vault wallet address. Send it wSOL and any other token the agent should use, plus a little SOL for position rent. Send the agent key a little SOL too. It pays network fees and the rent for what it creates, such as new DLMM bin arrays at about 0.07 SOL each, token accounts, limit orders, and launch configs. The vault does not limit that spending, so send only what you accept it using. Each simulation reports it as `agentLamportsCost`.

## 4. Give the agent its settings

Set these where the agent runs, or put them in a private file and set `METBOI_ENV_FILE` to its path:

```
METBOI_RPC=<your RPC URL>
METBOI_AGENT_KEY=<agent key path>
METBOI_VAULT=<vault address>
```

Do not put the owner key there.

## Emergency

If the agent key is lost or compromised: run `metboi pause --broadcast`, then `metboi owner-scan` to find the DLMM positions, DAMM v2 positions, and limit orders the wallet holds. It does not list token balances or DBC fees, so check those with `metboi status` or an explorer, close those positions with the owner commands below, and withdraw. These do not depend on the agent's rules or limits.

## Owner commands

Run these yourself, with `METBOI_OWNER_KEY` set. Without `--broadcast` they only simulate. For anything these do not cover, `ownerIx.ownerExecute` in the SDK runs any instruction as the wallet, so funds never depend on the agent's rule table.

```bash
metboi pause --broadcast
metboi resume --broadcast
metboi policy --policy policy.json --broadcast
metboi set-agent --agent <new agent public key> --broadcast
metboi withdraw-sol --to <address> --lamports <raw> --broadcast
metboi withdraw-token --mint <mint> --from <vault token account> --to <token account> --amount <raw> --broadcast
metboi owner-scan
metboi owner-dlmm-close --pool <address> --position <address> --broadcast
metboi owner-damm-close --pool <address> --position <address> --broadcast
metboi owner-limit-cancel --pool <address> --order <address> --bin <id> --broadcast
```
