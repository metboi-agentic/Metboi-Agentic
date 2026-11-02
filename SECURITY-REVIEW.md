# Security review, 2026-11-03

This is an internal review done with AI tools. It is not an independent audit, and no outside firm has reviewed this code.

## Result by area

| Area | Status |
|---|---|
| On-chain program | Not completed this round |
| SDK, CLI, MCP server, skill, site | Reviewed, findings fixed in 0.1.1 |
| Dependencies | Scanned, advisories remain |

## On-chain program

The review planned for this round did not finish. An automated safety check stopped the session while it was still reading source, so it produced no findings. That says nothing either way about whether the program is safe, so the program should be treated as not reviewed by this round.

Earlier work that does exist:

- Two static reviews on 2026-11-02, whose findings were fixed. The last batch of those fixes was not reviewed again.
- Attack tests on a local fork of mainnet programs, in `test/takeover`, `test/hardening`, and the venue test files. They cover what their authors thought to test.
- Clippy is clean, there is no `unsafe`, and overflow checks are on.

Not done: a full flow on mainnet with a real vault, and any independent review. One key can upgrade the program, and it is not in a multisig.

## Client code findings

All of these were fixed in 0.1.1. None needs a program upgrade.

| Severity | Finding | Fix |
|---|---|---|
| High | A transaction that landed and failed was reported as `ok: true`, and multi-step flows carried on | `send` throws with the signature, and flows stop |
| High | A mistyped `--side`, or `--sell true`, silently traded the other way | Strict values, and switches refuse a value |
| High | The package had no lockfile, floating versions, and one mutable URL | Exact versions, shrinkwrap, a versioned URL, and a checksum |
| Medium | A key pasted in place of a path appeared in the error | Fixed error text with no input in it |
| Medium | Environment beat flags, nothing showed the target, and unknown flags were ignored | Flags win, unknown flags are refused, and output shows vault, cluster, and destination |
| Medium | The skill's wrapper would run owner commands | It refuses them and drops the owner key from its environment |
| Medium | A swap re-quoted at send time, so the approved floor was not enforced | `--min-out` stops the swap below the approved floor |
| Medium | Owner DAMM close had a zero floor | A 100 bps floor by default |
| Medium | SOL spent by the agent key was understated, and config creation was not gated by the launch permission | Documented, shown as `agentLamportsCost`, and gated client side |
| Medium | Half a DLMM range was silently replaced by the default width | Refused |
| Medium | `dlmm-rebalance` checked the new range only after closing the old position | The range is checked first, so a bad range closes nothing |
| Medium | An RPC error after a transaction was sent lost its signature, and could invite a double send | The signature is kept, and `unconfirmed` is set when it may still land |
| Medium | Other flags a command does not read were ignored, so `damm-close --bps 5000` closed everything | Each command has a list of its flags and refuses the rest |
| Medium | DAMM v2 quotes left out pool fields, which gives wrong floors on compounding pools | All fields are passed |
| Low | Closing an empty DAMM v2 position failed on the client, and new account keys were dropped when confirmation was lost | Zero floors for empty positions, and keys are kept once sent |
| Low | DAMM slippage units were wrong, so floors were 100 times too tight | Passes basis points |
| Low | CLI numbers were unchecked, failures exited 0, and parser errors were stack traces | Validated, non-zero exit, and JSON errors |
| Low | The docs overstated `owner-scan`, and the MCP text for leftovers named the wrong destination | Corrected |
| Low | The site had no security headers, and a preview button appeared to pause an agent | Headers added, and the button says nothing was sent |
| Low | Site commands were not real syntax, and setup steps left out settings | Real commands, and crafted transactions are labeled |

Claims on the site that Meteora's program pays out to any named account when called directly are now checked by `test/direct.test.mjs`.

The fixes themselves were read by a second reviewer, which produced the rebalance, signature, flag, and quote findings above. Two bugs introduced while patching were caught by tests before release.

## Known limits that remain

- The quote fix was not tested on a real compounding pool, only that the fields reach the SDK.
- The fork tests have not exercised a landed-then-failed transaction against a real validator. That path is covered by a stubbed connection.
- Agent key SOL is not capped by the vault. Fund that key with only what you accept it spending.
- Owner and agent commands ship in one package. An agent with shell access can read any key file its account can reach, so the owner key belongs on another machine or user account.
- Limits stop an agent leaving the policy. They do not stop bad trades inside it.
- The site loads fonts from Google. The checksum is served from the same host as the package, so it catches a damaged download and not a compromised server.

## Owner console

The console at `/console` was added after this review and had its own read-only review, whose findings were fixed before release. Its instruction bytes are tested against the SDK and spl-token, and its flows ran on a local fork with a stand-in wallet. It has not been used with a real wallet. Its RPC gateway allows only reads and simulation.

## Dependencies

`npm audit` on the shipped tree reports 9 high and 7 moderate entries, all through transitive packages. The root causes are `toml` through `@coral-xyz/anchor`, `bigint-buffer` through `@solana/spl-token`, and `uuid` and `stream-json` through `@solana/web3.js`. They are not fixed upstream at versions these SDKs accept. Installing with `--ignore-scripts` keeps dependency install scripts from running, and the CLI was tested that way.

## Next

Get an independent review of the on-chain program before holding funds you could not afford to lose.
