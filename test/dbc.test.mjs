// DBC against the real program and real pools on the local fork, including a Token-2022 base mint.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Connection, PublicKey, LAMPORTS_PER_SOL as SOL, TransactionInstruction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { ACTIONS, RULES, fetchVault, ownerIx, send, wrapExecute } from '../sdk/index.mjs';
import { buildDbcSwap, loadDbc } from '../sdk/dbc.mjs';
import { mainnetRpc, startFork } from './fork.mjs';
import { attackerTokenAccount, balance, expectVaultError, lastExecute, redirect, setupVault } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { dbc, dbcToken2022 } = require('./pools.json');
const idl = require('../idl/meteora/dbc.json');
const names = RULES.DBC.instructions.swap.accounts;
const CASES = [
  ['SPL base mint', dbc, TOKEN_PROGRAM_ID],
  ['Token-2022 base mint', dbcToken2022, TOKEN_2022_PROGRAM_ID],
];

let fork, connection, env;
const pools = {};
const policy = (over = {}) => ({
  actions: ACTIONS.ALL, lamportTxCap: 0.3 * SOL, lamportDailyCap: SOL,
  pools: CASES.map(([, p]) => p.pool),
  budgets: [
    { mint: NATIVE_MINT, txCap: 0.5 * SOL, dailyCap: 5 * SOL },
    ...CASES.map(([, p]) => ({ mint: p.baseMint, txCap: '18446744073709551615', dailyCap: '18446744073709551615' })),
  ],
  ...over,
});
const setPolicy = (p) => send(connection, env.owner, [ownerIx.updatePolicy({ owner: env.owner.publicKey, vault: env.vault, policy: p })]);
const fail = (name, ixs) => expectVaultError(connection, env.agent, name, ixs);
const swap = (key, amountIn, sell = false) => buildDbcSwap({ pool: pools[key], vault: env.vault, agent: env.agent.publicKey, amountIn, sell });

before(async () => {
  const mainnet = new Connection(mainnetRpc(), 'confirmed');
  const clone = [];
  for (const [, p] of CASES) {
    const { state } = await loadDbc(mainnet, p.pool);
    clone.push(p.pool, p.config, String(state.baseMint), String(state.baseVault), String(state.quoteVault));
  }
  fork = await startFork({ programs: [RULES.DBC.programId], accounts: [...new Set(clone)] });
  connection = fork.connection;
  env = await setupVault(connection, { policy: policy() });
  for (const [, p] of CASES) pools[p.pool] = await loadDbc(connection, p.pool);
});
after(() => fork?.stop());

for (const [label, p, tokenProgram] of CASES) {
  test(`${label}: agent buys and sells through the real DBC program with both legs metered`, async () => {
    const walletBase = getAssociatedTokenAddressSync(new PublicKey(p.baseMint), env.wallet, true, tokenProgram);
    const solBefore = await balance(connection, env.walletSol);
    const spentBefore = (await fetchVault(connection, env.vault)).budgets[0].spent;
    await send(connection, env.agent, (await swap(p.pool, 0.05 * SOL)).instructions);
    assert.equal(solBefore - (await balance(connection, env.walletSol)), BigInt(0.05 * SOL));
    const bought = await balance(connection, walletBase, tokenProgram);
    assert.ok(bought > 0n, 'base token should arrive in the vault wallet');
    const state = await fetchVault(connection, env.vault);
    assert.equal(state.budgets[0].spent - spentBefore, BigInt(0.05 * SOL));

    pools[p.pool] = await loadDbc(connection, p.pool);
    const sell = bought / 2n;
    const solMid = await balance(connection, env.walletSol);
    await send(connection, env.agent, (await swap(p.pool, sell, true)).instructions);
    assert.equal(bought - (await balance(connection, walletBase, tokenProgram)), sell);
    assert.ok((await balance(connection, env.walletSol)) > solMid, 'wSOL should come back');
    const budget = (await fetchVault(connection, env.vault)).budgets.find((b) => b.mint.toBase58() === p.baseMint);
    assert.equal(budget.spent, sell, 'selling the base token is metered too');
    pools[p.pool] = await loadDbc(connection, p.pool);
  });

  test(`${label}: output, input, and referral redirects are refused`, async () => {
    const ix = lastExecute((await swap(p.pool, 0.01 * SOL)).instructions);
    const attackerBase = await attackerTokenAccount(connection, env.attacker, p.baseMint, tokenProgram);
    await fail('AccountNotOwnedByWallet', [redirect(ix, names.indexOf('output_token_account'), attackerBase)]);
    await fail('AccountNotOwnedByWallet', [redirect(ix, names.indexOf('input_token_account'), env.attackerSol)]);
    await fail('FeeRecipientNotAllowed', [redirect(ix, names.indexOf('referral_token_account'), env.attackerSol)]);
  });

  test(`${label}: unbudgeted sells and delisted pools are refused`, async () => {
    const sell = await swap(p.pool, 1000, true);
    await setPolicy(policy({ budgets: [{ mint: NATIVE_MINT, txCap: 0.5 * SOL, dailyCap: 5 * SOL }] }));
    await fail('MintNotAllowed', sell.instructions);
    await setPolicy(policy({ pools: [] }));
    await fail('PoolNotAllowed', sell.instructions);
    await setPolicy(policy());
  });
}

test('attack: DBC admin and migration instructions are not callable', async () => {
  for (const name of ['transfer_pool_creator', 'withdraw_migration_fee', 'swap2_with_transfer_hook', 'initialize_virtual_pool_with_token2022_transfer_hook', 'create_config']) {
    const ix = idl.instructions.find((i) => i.name === name);
    const instruction = new TransactionInstruction({ programId: new PublicKey(idl.address), keys: [], data: Buffer.from(ix.discriminator) });
    await fail('InstructionNotAllowed', [wrapExecute({ authority: env.agent.publicKey, vault: env.vault, instruction })]);
  }
});
