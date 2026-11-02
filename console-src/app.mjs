// The Metboi Agentic owner console. All values come from the chain, and every change is signed in the owner's wallet.
import { Buffer } from 'buffer';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  ACTION_LIST, MAX_BUDGETS, MAX_POOLS, PROGRAM_ID, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, U64_MAX, VAULT_SPACE, WSOL,
  ataAddress, budgetIxs, decodePool, decodeVault, explainFailure, formatAmount, labelTransaction, ownerIx, parseAmount, spentNow, tokenIx, transferSol, vaultPda, walletPda,
} from './chain.mjs';
import { connectWallet, disconnectWallet, discoverWallets, signAndSend, watchWallet } from './wallet.mjs';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (value, n = 4) => { const s = String(value); return `${s.slice(0, n)}…${s.slice(-n)}`; };
const explorer = (kind, id) => `https://explorer.solana.com/${kind}/${id}`;
const VAULTS_TO_SCAN = 20;
const REMEMBERED = 'metboi.wallet';
const KNOWN_TOKENS = { [WSOL]: 'wSOL', EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC', Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT' };
const tokenName = (mint) => KNOWN_TOKENS[mint] ?? short(mint);
const SOL_DECIMALS = 9;
const NO_LIMIT = 'no limit';

const state = {
  wallets: [], wallet: null, account: null, owner: null, vaults: [], current: null, detail: null, draftPools: [], draftBudgets: [], createPools: [], createBudgets: [],
  mints: new Map(), pools: new Map(), activity: new Map(), busy: false, stopWatching: null,
  loadSeq: 0, minSlot: 0, wantId: null, formSig: '', generated: new Set(), lastLink: null,
};

// ---- RPC

let rpcId = 0;
async function rpc(method, params = []) {
  const res = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const body = await res.json().catch(() => null);
  if (!body) throw new Error('The RPC gave an unreadable answer. Try again.');
  if (body.error) throw new Error(body.error.message);
  return body.result;
}
/** Reads at least as new as the last confirmed transaction, so a lagging RPC cannot bring old values back. */
const readOptions = (extra = {}) => ({ commitment: 'confirmed', ...extra, ...(state.minSlot ? { minContextSlot: state.minSlot } : {}) });
async function rpcFresh(method, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rpc(method, params);
    } catch (e) {
      if (attempt >= 8 || !/context slot/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
async function accounts(keys) {
  const list = keys.map(String);
  const out = [];
  for (let i = 0; i < list.length; i += 100) {
    const { value } = await rpcFresh('getMultipleAccounts', [list.slice(i, i + 100), readOptions({ encoding: 'base64' })]);
    out.push(...value.map((a) => (a ? { lamports: BigInt(a.lamports), owner: a.owner, data: Buffer.from(a.data[0], 'base64') } : null)));
  }
  return out;
}

/** Decimals and token program for each mint, cached for the session. */
async function loadMints(mints) {
  const missing = [...new Set(mints.map(String))].filter((m) => !state.mints.has(m));
  if (!missing.length) return;
  const infos = await accounts(missing);
  infos.forEach((info, i) => {
    // A Token-2022 mint with extensions marks itself at byte 165. A token account is 165 bytes or marks itself differently.
    const isMint = info && (info.owner === TOKEN_PROGRAM.toBase58() || info.owner === TOKEN_2022_PROGRAM.toBase58()) && info.data[45] === 1
      && (info.data.length === 82 || (info.data.length > 165 && info.data[165] === 1));
    if (isMint) state.mints.set(missing[i], { decimals: info.data[44], program: new PublicKey(info.owner) });
  });
}
const mintInfo = (mint) => state.mints.get(String(mint)) ?? null;
async function loadPools(pools) {
  const list = pools.map(String);
  const infos = await accounts(list);
  infos.forEach((info, i) => state.pools.set(list[i], info ? decodePool(info.owner, info.data) ?? { foreign: true } : { missing: true }));
  await loadMints(infos.flatMap((info, i) => state.pools.get(list[i])?.mints ?? []));
}

// ---- Transactions

const setLine = (text, kind = '', link) => {
  const line = $('txline');
  line.hidden = !text;
  line.className = `txline ${kind}`;
  line.textContent = text ?? '';
  if (link) {
    const a = document.createElement('a');
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = link.text;
    line.append(' ', a);
  }
};
const setBusy = (busy) => {
  state.busy = busy;
  document.querySelectorAll('#app button').forEach((b) => { b.disabled = busy; });
};

async function simulateIxs(instructions) {
  const { value: { blockhash } } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const tx = new Transaction({ feePayer: state.owner, recentBlockhash: blockhash }).add(...instructions);
  const encoded = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  const { value } = await rpc('simulateTransaction', [encoded, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]);
  return value;
}

/** Simulates, has the wallet sign and send, waits for confirmation, then reloads. Nothing reaches the wallet if the simulation fails. */
async function act(label, build) {
  if (state.busy) return false;
  setBusy(true);
  state.loadSeq += 1; // Any refresh already running must not overwrite what follows.
  state.lastLink = null;
  try {
    setLine(`Checking: ${label}`);
    const instructions = await build();
    const sim = await simulateIxs(instructions);
    if (sim.err) {
      setLine(explainFailure(sim.err, sim.logs ?? []), 'bad');
      return false;
    }
    const units = Math.min(1_400_000, Math.ceil((sim.unitsConsumed ?? 150_000) * 1.5) + 20_000);
    const { value: { blockhash } } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const tx = new Transaction({ feePayer: state.owner, recentBlockhash: blockhash }).add(...budgetIxs(units), ...instructions);
    setLine(`Approve in your wallet: ${label}`);
    const signature = bs58.encode(await signAndSend(state.wallet, state.account, tx.serialize({ requireAllSignatures: false, verifySignatures: false })));
    const link = { href: explorer('tx', signature), text: 'View transaction' };
    state.lastLink = link;
    setLine(`Sent: ${label}. Waiting for confirmation.`, '', link);
    const outcome = await waitFor(signature);
    if (outcome === 'timeout') {
      setLine('Not confirmed yet, and it may still land. Check it before trying again.', 'bad', link);
      return false;
    }
    if (outcome !== 'ok') {
      setLine(`The transaction failed on chain: ${outcome}`, 'bad', link);
      return false;
    }
    setLine(`Done: ${label}.`, 'good', link);
    return true;
  } catch (e) {
    if (state.lastLink) {
      setLine('Sent, but its result could not be read, so it may have gone through. Check it before trying again.', 'bad', state.lastLink);
      return false;
    }
    const cancelled = e?.code === 4001 || /reject|cancel|declin/i.test(e?.message ?? '');
    setLine(cancelled ? 'You cancelled in your wallet. Nothing was sent.' : e.message, cancelled ? '' : 'bad');
    return false;
  } finally {
    setBusy(false);
  }
}

async function waitFor(signature) {
  for (let i = 0; i < 45; i++) {
    try {
      const { value: [status] } = await rpc('getSignatureStatuses', [[signature]]);
      if (status?.err) return JSON.stringify(status.err);
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        state.minSlot = Math.max(state.minSlot, status.slot ?? 0);
        return 'ok';
      }
    } catch {
      // The transaction is out already, so an RPC error here only means asking again.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return 'timeout';
}

// ---- Loading

async function loadVaults() {
  const addresses = Array.from({ length: VAULTS_TO_SCAN }, (_, id) => vaultPda(state.owner, BigInt(id)));
  const infos = await accounts(addresses);
  state.vaults = infos.flatMap((info, id) => (info && info.owner === PROGRAM_ID.toBase58() ? [{ id: BigInt(id), address: addresses[id], ...decodeVault(info.data) }] : []));
}

/** Loads one vault fully, then switches to it in one step. A newer load or a transaction cancels this one. */
async function loadDetail(target = state.current) {
  if (!target) return false;
  const seq = ++state.loadSeq;
  const wallet = walletPda(target.address);
  const [walletInfo, agentInfo, ownerInfo, vaultInfo] = await accounts([wallet, target.agent, state.owner, target.address]);
  const fresh = { id: target.id, address: target.address, ...decodeVault(vaultInfo.data) };
  const tokens = [];
  for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const { value } = await rpcFresh('getTokenAccountsByOwner', [wallet.toBase58(), { programId: program.toBase58() }, readOptions({ encoding: 'jsonParsed' })]);
    for (const { pubkey, account } of value) {
      const { mint, tokenAmount } = account.data.parsed.info;
      state.mints.set(mint, { decimals: tokenAmount.decimals, program });
      tokens.push({ account: pubkey, mint, amount: BigInt(tokenAmount.amount), decimals: tokenAmount.decimals, program });
    }
  }
  await loadMints(fresh.budgets.map((b) => b.mint));
  await loadPools(fresh.pools);
  if (seq !== state.loadSeq) return false;
  state.current = fresh;
  state.vaults = state.vaults.map((x) => (x.id === fresh.id ? fresh : x));
  state.detail = { wallet, walletLamports: walletInfo?.lamports ?? 0n, agentLamports: agentInfo?.lamports ?? 0n, ownerLamports: ownerInfo?.lamports ?? 0n, tokens };
  return true;
}

async function loadActivity() {
  const v = state.current;
  if (!v) return [];
  const signatures = await rpc('getSignaturesForAddress', [v.address.toBase58(), { limit: 15, commitment: 'confirmed' }]);
  if (state.current?.id !== v.id) return null;
  const missing = signatures.filter((s) => !state.activity.has(s.signature));
  for (let i = 0; i < missing.length; i += 3) {
    await Promise.all(missing.slice(i, i + 3).map(async ({ signature }) => {
      const tx = await rpc('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
      if (tx) state.activity.set(signature, labelTransaction(tx, v.owner, (data) => bs58.decode(data)));
    }));
  }
  return signatures.map((s) => ({ signature: s.signature, time: s.blockTime, ...(state.activity.get(s.signature) ?? { who: 'other', what: 'Transaction', failed: Boolean(s.err) }) }));
}

// ---- Drawing

const capText = (raw, decimals, name) => (raw === U64_MAX ? NO_LIMIT : `${formatAmount(raw, decimals, 6)} ${name}`);
const capInput = (raw, decimals) => (raw === U64_MAX ? NO_LIMIT : formatAmount(raw, decimals).replaceAll(',', ''));

function meterHtml(name, meter, decimals, unit = name) {
  const spent = spentNow(meter);
  const share = meter.dailyCap === U64_MAX || meter.dailyCap === 0n ? 0 : Number((spent * 10_000n) / meter.dailyCap) / 100;
  const tx = capText(meter.txCap, decimals, unit), day = capText(meter.dailyCap, decimals, unit);
  return `<div class="meter">
    <div class="meter-top"><b>${esc(name)}</b><span>${esc(formatAmount(spent, decimals, 6))} of ${esc(day)}</span></div>
    <div class="seg"><i style="width:${Math.min(share, 100)}%"></i></div>
    <small>${tx === NO_LIMIT ? NO_LIMIT : `${esc(tx)} per trade`} · rolling 24 hours</small>
  </div>`;
}

function paintReadouts() {
  const v = state.current, d = state.detail;
  if (!v || !d) return;
  const expired = v.agentExpiresAt && v.agentExpiresAt * 1000 < Date.now();
  $('state').textContent = v.paused ? 'Agent paused' : expired ? 'Agent key expired' : 'Agent active';
  $('state').classList.toggle('off', Boolean(v.paused || expired));
  $('pause').textContent = v.paused ? 'Resume agent' : 'Pause agent';
  $('pause').classList.toggle('danger', !v.paused);
  $('pause').classList.toggle('primary', v.paused);
  $('meters').innerHTML = v.budgets.map((b) => {
    const mint = String(b.mint);
    return meterHtml(tokenName(mint), b.meter, mintInfo(mint)?.decimals ?? 0);
  }).join('') + meterHtml('SOL for rent', v.lamports, SOL_DECIMALS, 'SOL');
  const balances = [
    ...d.tokens.filter((t) => t.amount > 0n).map((t) => `<div class="kv"><span>${esc(tokenName(t.mint))}</span><span class="v">${esc(formatAmount(t.amount, t.decimals, 6))}</span></div>`),
    `<div class="kv"><span>SOL</span><span class="v">${esc(formatAmount(d.walletLamports, SOL_DECIMALS, 6))}</span></div>`,
  ].join('');
  $('balances').innerHTML = balances;
  $('balances-2').innerHTML = balances;
  $('start-card').hidden = d.walletLamports > 0n || d.tokens.some((t) => t.amount > 0n);
  $('vault-address').innerHTML = `<a href="${explorer('address', v.address)}" target="_blank" rel="noopener">${esc(short(v.address))}</a>`;
  $('pool-count').textContent = String(v.pools.length);
  $('actions-on').textContent = `${ACTION_LIST.filter((a) => v.actions & a.bit).length} of ${ACTION_LIST.length}`;
  $('agent-short').textContent = short(v.agent);
  const expiresText = v.agentExpiresAt ? new Date(v.agentExpiresAt * 1000).toUTCString() : 'Never';
  $('expires').textContent = expiresText;
  $('agent-full').textContent = String(v.agent);
  $('agent-expires').textContent = expiresText;
  $('agent-balance').textContent = `${formatAmount(d.agentLamports, SOL_DECIMALS, 6)} SOL`;
  $('wallet-full').textContent = d.wallet.toBase58();
  $('mcp-env').textContent = `METBOI_RPC=<your RPC URL>\nMETBOI_AGENT_KEY=<path to agent key file>\nMETBOI_VAULT=${v.address.toBase58()}`;
  const selected = $('withdraw-token').value;
  $('withdraw-token').innerHTML = `<option value="sol">SOL, ${esc(formatAmount(d.walletLamports, SOL_DECIMALS, 6))}</option>` + d.tokens.filter((t) => t.amount > 0n)
    .map((t) => `<option value="${esc(t.account)}">${esc(tokenName(t.mint))}, ${esc(formatAmount(t.amount, t.decimals, 6))}</option>`).join('');
  if ([...$('withdraw-token').options].some((o) => o.value === selected)) $('withdraw-token').value = selected;
  else $('withdraw-amount').value = ''; // The token it was typed for is gone, so the number must not carry over to another.
  if (!$('withdraw-to').value) $('withdraw-to').value = state.owner.toBase58();
}

const rowHtml = (r) => `<li>
  <span class="tag ${r.failed ? 'no' : r.who === 'owner' ? 'owner' : 'ok'}">${r.failed ? 'FAILED' : r.who.toUpperCase()}</span>
  <span class="what">${esc(r.what)}${r.time ? `<br><small>${esc(new Date(r.time * 1000).toLocaleString())}</small>` : ''}</span>
  <span class="detail"><a href="${esc(explorer('tx', r.signature))}" target="_blank" rel="noopener">${esc(short(r.signature))}</a></span>
</li>`;
const EMPTY_ACTIVITY = '<li class="empty-row"><span class="what">Nothing yet.</span></li>';
async function paintActivity() {
  const rows = await loadActivity();
  if (!rows) return;
  $('latest').innerHTML = rows.slice(0, 5).map(rowHtml).join('') || EMPTY_ACTIVITY;
  $('all-rows').innerHTML = rows.map(rowHtml).join('') || EMPTY_ACTIVITY;
}

const budgetRow = (b, index, scope) => {
  const info = mintInfo(b.mint);
  const decimals = info?.decimals ?? 0;
  return `<div class="form-row with-remove" data-scope="${scope}"><div><b style="font-weight:500">${esc(tokenName(b.mint))}</b></div>
    <label>Per trade<input type="text" inputmode="decimal" autocomplete="off" data-budget="${index}" data-field="tx" value="${esc(b.tx ?? capInput(b.txCap, decimals))}"></label>
    <label>Per 24 hours<input type="text" inputmode="decimal" autocomplete="off" data-budget="${index}" data-field="day" value="${esc(b.day ?? capInput(b.dailyCap, decimals))}"></label>
    <button class="btn field-remove" type="button" data-remove-budget="${index}" data-scope="${scope}" aria-label="Remove ${esc(tokenName(b.mint))}">Remove</button></div>`;
};
const solRow = (scope, tx, day) => `<div class="form-row with-remove"><div><b style="font-weight:500">SOL for rent</b></div>
  <label>Per trade<input type="text" inputmode="decimal" autocomplete="off" id="${scope}-sol-tx" value="${esc(tx)}"></label>
  <label>Per 24 hours<input type="text" inputmode="decimal" autocomplete="off" id="${scope}-sol-day" value="${esc(day)}"></label><span></span></div>`;
const actionToggles = (scope, actions) => ACTION_LIST.map((a) => `<label class="toggle">${esc(a.label)}<input type="checkbox" data-action-scope="${scope}" data-bit="${a.bit}" ${actions & a.bit ? 'checked' : ''}></label>`).join('');
const readActions = (scope) => [...document.querySelectorAll(`[data-action-scope="${scope}"]`)].reduce((sum, input) => (input.checked ? sum + Number(input.dataset.bit) : sum), 0);

/** Keeps what the owner typed when rows are added or removed. */
function captureBudgets(list, scope) {
  document.querySelectorAll(`[data-scope="${scope}"] input[data-budget]`).forEach((input) => {
    const row = list[Number(input.dataset.budget)];
    if (row) row[input.dataset.field] = input.value;
  });
}

function paintLimitForm() {
  const v = state.current;
  if (!v) return;
  captureBudgets(state.draftBudgets, 'limits');
  const tx = $('limits-sol-tx')?.value ?? capInput(v.lamports.txCap, SOL_DECIMALS), day = $('limits-sol-day')?.value ?? capInput(v.lamports.dailyCap, SOL_DECIMALS);
  $('limit-form').innerHTML = state.draftBudgets.map((b, i) => budgetRow(b, i, 'limits')).join('') + solRow('limits', tx, day);
}

function poolLabel(address) {
  const info = state.pools.get(address);
  if (!info || info.missing) return { venue: 'Not created yet', tokens: '' };
  if (info.foreign) return { venue: 'Not a Meteora pool', tokens: '' };
  return { venue: info.venue, tokens: info.mints.map(tokenName).join(' / ') };
}

function paintPools() {
  const v = state.current;
  if (!v) return;
  $('pool-used').textContent = String(state.draftPools.length);
  $('pool-rows').innerHTML = state.draftPools.map((address) => {
    const { venue, tokens } = poolLabel(address);
    return `<tr><td>${esc(venue)}</td><td>${esc(tokens)}</td><td class="mono"><a href="${explorer('address', address)}" target="_blank" rel="noopener">${esc(short(address, 6))}</a></td>
      <td style="text-align:right"><button class="btn" style="min-height:36px" type="button" data-remove-pool="${esc(address)}" data-scope="pools">Remove</button></td></tr>`;
  }).join('') || '<tr><td colspan="4">No pools yet. The agent cannot trade until you add one.</td></tr>';
  const saved = v.pools.map(String);
  const dirty = saved.length !== state.draftPools.length || saved.some((p) => !state.draftPools.includes(p));
  $('pools-dirty').textContent = dirty ? 'Not saved yet. Your wallet signs one transaction.' : 'Your wallet signs one transaction.';
}

function paintCreate() {
  captureBudgets(state.createBudgets, 'create');
  const tx = $('create-sol-tx')?.value ?? '0.1', day = $('create-sol-day')?.value ?? '0.3';
  $('create-limits').innerHTML = state.createBudgets.map((b, i) => budgetRow(b, i, 'create')).join('') + solRow('create', tx, day);
  $('create-pools').innerHTML = state.createPools.map((address) => {
    const { venue, tokens } = poolLabel(address);
    return `<div class="pick-row"><span>${esc(venue)} ${esc(tokens)}<br><code>${esc(address)}</code></span><button class="btn" type="button" data-remove-pool="${esc(address)}" data-scope="create">Remove</button></div>`;
  }).join('');
}

/** The saved limits and pools, leaving out spend counters. */
const policySig = (v) => JSON.stringify([v.actions, String(v.lamports.txCap), String(v.lamports.dailyCap), v.pools.map(String), v.budgets.map((b) => [String(b.mint), String(b.meter.txCap), String(b.meter.dailyCap)])]);

function resetForms() {
  const v = state.current;
  if (!v) return;
  state.draftPools = v.pools.map(String);
  state.draftBudgets = v.budgets.map((b) => ({ mint: String(b.mint), txCap: b.meter.txCap, dailyCap: b.meter.dailyCap }));
  state.formSig = policySig(v);
  $('limit-form').innerHTML = '';
  paintLimitForm();
  $('limit-actions').innerHTML = actionToggles('limits', v.actions);
  paintPools();
  $('vault-select').innerHTML = state.vaults.map((x) => `<option value="${x.id}">#${x.id} ${esc(short(x.address))}</option>`).join('');
  $('vault-select').value = String(v.id);
  $('vault-pick').hidden = state.vaults.length < 2;
}

// ---- Routing

const VIEWS = { overview: 'overview', limits: 'limits', pools: 'pools', agent: 'agent-key', funds: 'funds', activity: 'activity', create: 'new-vault' };
function route() {
  const hasVault = Boolean(state.current);
  let view = location.hash.slice(1);
  if (!VIEWS[view] || !hasVault) view = hasVault ? 'overview' : 'create';
  document.querySelectorAll('.view').forEach((el) => { el.hidden = el.dataset.view !== view; });
  document.querySelectorAll('#side-nav a').forEach((a) => {
    if (a.getAttribute('href') === `#${view}`) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('side-nav').hidden = !hasVault;
  $('pause').hidden = !hasVault || view === 'create';
  $('state').hidden = !hasVault || view === 'create';
  $('new-vault').hidden = !hasVault || view === 'create';
  $('view-title').textContent = VIEWS[view];
  if (view === 'create') paintCreate();
}

// ---- Connecting

function paintGate() {
  $('wallet-list').innerHTML = state.wallets.map((w, i) => `<button class="btn" type="button" data-connect="${i}"><img src="${esc(w.icon)}" alt="" width="22" height="22">${esc(w.name)}</button>`).join('');
  $('gate-note').textContent = state.wallets.length ? 'Pick a wallet.' : 'No Solana wallet found in this browser. Install Phantom or Solflare, then reload this page.';
}

async function connect(wallet, silent = false) {
  $('gate-error').textContent = '';
  try {
    state.wallet = wallet;
    state.account = await connectWallet(wallet, silent);
    state.owner = new PublicKey(state.account.address);
    try { localStorage.setItem(REMEMBERED, wallet.name); } catch { /* A blocked store only skips the reconnect. */ }
    state.stopWatching?.();
    state.stopWatching = watchWallet(wallet, ({ accounts: changed }) => { if (changed && changed[0]?.address !== state.account?.address) location.reload(); });
    $('side-owner').textContent = short(state.owner);
    $('withdraw-to').value = state.owner.toBase58();
    await reload(true);
    $('gate').hidden = true;
    $('app').hidden = false;
  } catch (e) {
    state.wallet = null;
    state.owner = null;
    if (state.account) $('gate-error').textContent = `Your wallet connected, but your vaults could not be read: ${e.message}`;
    else if (!silent) $('gate-error').textContent = /reject|cancel|declin/i.test(e?.message ?? '') ? 'You cancelled in your wallet.' : e.message;
    state.account = null;
  }
}

async function reload(forms = false) {
  await loadVaults();
  const wanted = state.wantId ?? state.current?.id;
  state.wantId = null;
  const target = state.vaults.find((v) => v.id === wanted) ?? state.vaults[0] ?? null;
  if (!target) state.current = null;
  if (target) {
    await loadDetail(target);
    if (forms) resetForms();
    paintReadouts();
    paintActivity().catch(() => {});
  }
  route();
}

// ---- Reading forms

function address(text, what) {
  try {
    return new PublicKey(String(text).trim());
  } catch {
    throw new Error(`${what} is not a valid address.`);
  }
}
function capValue(text, decimals, label) {
  const value = String(text).trim().toLowerCase();
  if (value === NO_LIMIT) return U64_MAX;
  try {
    return parseAmount(value, decimals);
  } catch (e) {
    throw new Error(`${label}: ${e.message}`);
  }
}
function expiryValue(text) {
  const value = String(text).trim();
  if (!value || /^never$/i.test(value)) return 0;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T23:59:59Z`))) throw new Error('Write the expiry date as YYYY-MM-DD, or leave it empty for never.');
  const seconds = Math.floor(Date.parse(`${value}T23:59:59Z`) / 1000);
  if (seconds * 1000 <= Date.now()) throw new Error('The expiry date has already passed.');
  return seconds;
}
function readPolicy({ scope, budgets, pools }) {
  const rows = budgets.map((b, i) => {
    const info = mintInfo(b.mint);
    if (!info) throw new Error(`Could not read token ${short(b.mint)}.`);
    const name = tokenName(b.mint);
    const txInput = document.querySelector(`[data-scope="${scope}"] input[data-budget="${i}"][data-field="tx"]`);
    const dayInput = document.querySelector(`[data-scope="${scope}"] input[data-budget="${i}"][data-field="day"]`);
    const txCap = capValue(txInput.value, info.decimals, `${name} per trade`), dailyCap = capValue(dayInput.value, info.decimals, `${name} per 24 hours`);
    if (txCap > dailyCap) throw new Error(`${name}: the per trade limit is above the 24 hour limit.`);
    return { mint: b.mint, txCap, dailyCap };
  });
  const lamportTxCap = capValue($(`${scope}-sol-tx`).value, SOL_DECIMALS, 'SOL per trade'), lamportDailyCap = capValue($(`${scope}-sol-day`).value, SOL_DECIMALS, 'SOL per 24 hours');
  if (lamportTxCap > lamportDailyCap) throw new Error('SOL for rent: the per trade limit is above the 24 hour limit.');
  return { actions: readActions(scope), lamportTxCap, lamportDailyCap, pools, budgets: rows };
}

/** Writes a new key file to the owner's downloads. The secret never leaves this browser. */
function generateAgentKey(input, note) {
  const key = Keypair.generate();
  const publicKey = key.publicKey.toBase58();
  const url = URL.createObjectURL(new Blob([JSON.stringify([...key.secretKey])], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `metboi-agent-${publicKey.slice(0, 6)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  input.value = publicKey;
  state.generated.add(publicKey);
  note.textContent = 'Check your downloads for the key file. Give it to your agent, and keep it private. If it did not save, generate another.';
}

/** A generated key is useless without its file, and only the browser knows if the download finished. */
const keyFileSaved = (publicKey) => !state.generated.has(publicKey) || window.confirm('Did the key file save to your downloads? Without it, nobody can use this agent key.');

/** Reads the vault again, and refuses to save over limits changed somewhere else since this page loaded them. */
async function freshPolicyBase() {
  const v = state.current;
  const [info] = await accounts([v.address]);
  const fresh = { id: v.id, address: v.address, ...decodeVault(info.data) };
  if (policySig(fresh) !== state.formSig) {
    state.current = fresh;
    resetForms();
    throw new Error('These limits changed somewhere else, so this page reloaded them. Check them and save again.');
  }
  return fresh;
}

// ---- Events

async function addPool(scope) {
  const input = $(`${scope}-pool`);
  const list = scope === 'create' ? state.createPools : state.draftPools;
  try {
    const value = address(input.value, 'That pool').toBase58();
    if (list.includes(value)) throw new Error('That pool is already listed.');
    if (list.length >= MAX_POOLS) throw new Error(`A vault can list up to ${MAX_POOLS} pools.`);
    await loadPools([value]);
    if (state.pools.get(value)?.foreign) throw new Error('That address is not a DLMM, DAMM v2, or DBC pool.');
    list.push(value);
    input.value = '';
    setLine('');
    if (scope === 'create') paintCreate(); else paintPools();
  } catch (e) {
    setLine(e.message, 'bad');
  }
}

async function addMint(scope) {
  const input = $(`${scope}-mint`);
  const list = scope === 'create' ? state.createBudgets : state.draftBudgets;
  captureBudgets(list, scope);
  try {
    const value = address(input.value, 'That token').toBase58();
    if (list.some((b) => b.mint === value)) throw new Error('That token is already listed.');
    if (list.length >= MAX_BUDGETS) throw new Error(`A vault can list up to ${MAX_BUDGETS} tokens.`);
    await loadMints([value]);
    if (!mintInfo(value)) throw new Error('That address is not a token mint.');
    list.push({ mint: value, tx: '0', day: '0' });
    input.value = '';
    setLine('');
    if (scope === 'create') paintCreate(); else paintLimitForm();
  } catch (e) {
    setLine(e.message, 'bad');
  }
}

const after = async (ok) => {
  if (!ok) {
    state.wantId = null;
    return;
  }
  setBusy(true);
  try {
    await reload(true);
  } catch {
    setLine('It went through, but this page could not refresh. Reload it before doing anything else.', 'bad', state.lastLink);
  } finally {
    setBusy(false);
  }
};

const handlers = {
  async 'create-vault'() {
    const typed = $('create-agent').value.trim();
    if (!keyFileSaved(typed)) return;
    const before = state.vaults.length;
    await after(await act('Create vault', async () => {
      const agent = address(typed, 'The agent key');
      if (agent.equals(state.owner)) throw new Error('The agent key must be different from your wallet.');
      captureBudgets(state.createBudgets, 'create');
      await loadMints(state.createBudgets.map((b) => b.mint));
      const used = new Set(state.vaults.map((v) => v.id));
      let id = 0n;
      while (used.has(id)) id += 1n;
      if (id >= BigInt(VAULTS_TO_SCAN)) throw new Error(`This console shows up to ${VAULTS_TO_SCAN} vaults per wallet.`);
      state.wantId = id;
      return [ownerIx.initialize({ owner: state.owner, id, agent, agentExpiresAt: expiryValue($('create-expires').value), policy: readPolicy({ scope: 'create', budgets: state.createBudgets, pools: state.createPools }) })];
    }));
    if (state.vaults.length > before) location.hash = '#overview';
  },
  'create-generate'() { generateAgentKey($('create-agent'), $('create-generate-note')); },
  'agent-generate'() { generateAgentKey($('agent-new'), $('agent-generate-note')); },
  'new-vault'() { location.hash = '#create'; },
  async pause() {
    const v = state.current;
    await after(await act(v.paused ? 'Resume agent' : 'Pause agent', () => [ownerIx.setPaused({ owner: state.owner, vault: v.address, paused: !v.paused })]));
  },
  async 'save-limits'() {
    await after(await act('Save limits', async () => {
      const v = await freshPolicyBase();
      captureBudgets(state.draftBudgets, 'limits');
      return [ownerIx.updatePolicy({ owner: state.owner, vault: v.address, policy: readPolicy({ scope: 'limits', budgets: state.draftBudgets, pools: v.pools.map(String) }) })];
    }));
  },
  async 'save-pools'() {
    await after(await act('Save pools', async () => {
      const v = await freshPolicyBase();
      return [ownerIx.updatePolicy({
        owner: state.owner, vault: v.address,
        policy: { actions: v.actions, lamportTxCap: v.lamports.txCap, lamportDailyCap: v.lamports.dailyCap, pools: state.draftPools, budgets: v.budgets.map((b) => ({ mint: b.mint, txCap: b.meter.txCap, dailyCap: b.meter.dailyCap })) },
      })];
    }));
  },
  async 'agent-save'() {
    const v = state.current;
    const typed = $('agent-new').value.trim();
    if (!keyFileSaved(typed)) return;
    const ok = await act('Replace agent key', () => {
      const agent = address(typed, 'The new agent key');
      if (agent.equals(state.owner)) throw new Error('The agent key must be different from your wallet.');
      return [ownerIx.setAgent({ owner: state.owner, vault: v.address, agent, agentExpiresAt: expiryValue($('agent-new-expires').value) })];
    });
    if (ok) {
      $('agent-new').value = '';
      $('agent-new-expires').value = '';
      $('agent-generate-note').textContent = '';
    }
    await after(ok);
  },
  async 'agent-send'() {
    const v = state.current;
    const ok = await act('Send SOL to the agent key', () => {
      const lamports = parseAmount($('agent-topup').value, SOL_DECIMALS);
      if (!lamports) throw new Error('Enter an amount.');
      return [transferSol(state.owner, v.agent, lamports)];
    });
    if (ok) $('agent-topup').value = '';
    await after(ok);
  },
  async 'deposit-send'() {
    const wallet = walletPda(state.current.address);
    const ok = await act('Deposit', async () => {
      const kind = $('deposit-kind').value, text = $('deposit-amount').value;
      if (kind === 'sol' || kind === 'wsol') {
        const lamports = parseAmount(text, SOL_DECIMALS);
        if (!lamports) throw new Error('Enter an amount.');
        if (kind === 'sol') return [transferSol(state.owner, wallet, lamports)];
        const target = ataAddress(wallet, WSOL);
        return [tokenIx.createAtaIdempotent({ payer: state.owner, owner: wallet, mint: WSOL }), transferSol(state.owner, target, lamports), tokenIx.syncNative(target)];
      }
      const mint = address($('deposit-mint').value, 'That token').toBase58();
      await loadMints([mint]);
      const info = mintInfo(mint);
      if (!info) throw new Error('That address is not a token mint.');
      const amount = parseAmount(text, info.decimals);
      if (!amount) throw new Error('Enter an amount.');
      return [
        tokenIx.createAtaIdempotent({ payer: state.owner, owner: wallet, mint, tokenProgram: info.program }),
        tokenIx.transferChecked({ from: ataAddress(state.owner, mint, info.program), mint, to: ataAddress(wallet, mint, info.program), owner: state.owner, amount, decimals: info.decimals, tokenProgram: info.program }),
      ];
    });
    if (ok) $('deposit-amount').value = '';
    await after(ok);
  },
  'withdraw-max'() {
    const pick = $('withdraw-token').value, d = state.detail;
    if (pick === 'sol') $('withdraw-amount').value = formatAmount(d.walletLamports, SOL_DECIMALS).replaceAll(',', '');
    else {
      const t = d.tokens.find((x) => x.account === pick);
      if (t) $('withdraw-amount').value = formatAmount(t.amount, t.decimals).replaceAll(',', '');
    }
  },
  async 'withdraw-send'() {
    const v = state.current;
    const pick = $('withdraw-token').value;
    const token = pick === 'sol' ? null : state.detail.tokens.find((x) => x.account === pick);
    if (pick !== 'sol' && !token) throw new Error('Pick a token.');
    const amount = parseAmount($('withdraw-amount').value, token ? token.decimals : SOL_DECIMALS);
    if (!amount) throw new Error('Enter an amount.');
    const to = address($('withdraw-to').value, 'The destination').toBase58();
    if (to === walletPda(v.address).toBase58()) throw new Error('That is the vault wallet itself. Enter another address.');
    if (to !== state.owner.toBase58()) {
      // A token account or program as the destination would strand the funds.
      const [info] = await accounts([to]);
      if (info && info.owner !== SystemProgram.programId.toBase58()) throw new Error('That address is not a wallet. Enter a wallet address, not a token account or a program.');
      const what = `${formatAmount(amount, token ? token.decimals : SOL_DECIMALS)} ${token ? tokenName(token.mint) : 'SOL'}`;
      if (!window.confirm(`Send ${what} to ${to}? This is not your connected wallet.`)) return;
    }
    const ok = await act('Withdraw', () => (token ? [
      tokenIx.createAtaIdempotent({ payer: state.owner, owner: to, mint: token.mint, tokenProgram: token.program }),
      ownerIx.withdrawToken({ owner: state.owner, vault: v.address, mint: token.mint, from: token.account, to: ataAddress(to, token.mint, token.program), amount, tokenProgram: token.program }),
    ] : [ownerIx.withdrawSol({ owner: state.owner, vault: v.address, to, lamports: amount })]));
    if (ok) $('withdraw-amount').value = '';
    await after(ok);
  },
  async disconnect() {
    try { localStorage.removeItem(REMEMBERED); } catch { /* Nothing to clear. */ }
    await disconnectWallet(state.wallet)?.catch?.(() => {});
    location.reload();
  },
};

document.addEventListener('click', (event) => {
  const el = event.target.closest('button');
  if (!el) return;
  if (el.dataset.connect !== undefined) return connect(state.wallets[Number(el.dataset.connect)]);
  if (el.dataset.addPool) return addPool(el.dataset.addPool);
  if (el.dataset.addMint) return addMint(el.dataset.addMint);
  if (el.dataset.removePool) {
    const scope = el.dataset.scope;
    if (scope === 'create') {
      state.createPools = state.createPools.filter((p) => p !== el.dataset.removePool);
      return paintCreate();
    }
    state.draftPools = state.draftPools.filter((p) => p !== el.dataset.removePool);
    return paintPools();
  }
  if (el.dataset.removeBudget !== undefined) {
    const scope = el.dataset.scope;
    const list = scope === 'create' ? state.createBudgets : state.draftBudgets;
    captureBudgets(list, scope);
    list.splice(Number(el.dataset.removeBudget), 1);
    return scope === 'create' ? paintCreate() : paintLimitForm();
  }
  const handler = handlers[el.id];
  if (handler) Promise.resolve(handler()).catch((e) => setLine(e.message, 'bad'));
});
$('deposit-kind').addEventListener('change', () => { $('deposit-mint-row').hidden = $('deposit-kind').value !== 'token'; });
$('withdraw-token').addEventListener('change', () => { $('withdraw-amount').value = ''; });
$('vault-select').addEventListener('change', async () => {
  const target = state.vaults.find((v) => String(v.id) === $('vault-select').value);
  if (!target || state.busy) return;
  setBusy(true);
  setLine('');
  try {
    if (await loadDetail(target)) {
      state.activity.clear();
      $('withdraw-amount').value = '';
      resetForms();
      paintReadouts();
      paintActivity().catch(() => {});
      route();
    }
  } catch (e) {
    $('vault-select').value = String(state.current.id);
    setLine(`That vault could not be loaded, so you are still on vault #${state.current.id}. ${e.message}`, 'bad');
  } finally {
    setBusy(false);
  }
});
addEventListener('hashchange', route);

setInterval(() => {
  if (!state.current || state.busy || document.hidden) return;
  loadDetail().then(paintReadouts).catch(() => {});
}, 45_000);

// ---- Start

async function start() {
  state.createBudgets = [{ mint: WSOL, tx: '0.03', day: '0.06' }];
  state.mints.set(WSOL, { decimals: SOL_DECIMALS, program: TOKEN_PROGRAM });
  $('create-actions').innerHTML = actionToggles('create', 31);
  $('create-rent').textContent = '…';
  rpc('getMinimumBalanceForRentExemption', [VAULT_SPACE]).then((lamports) => { $('create-rent').textContent = formatAmount(BigInt(lamports), SOL_DECIMALS, 4); }).catch(() => { $('create-rent').textContent = '0.022'; });
  let remembered = null;
  try { remembered = localStorage.getItem(REMEMBERED); } catch { /* Reconnect is optional. */ }
  discoverWallets((wallet) => {
    state.wallets.push(wallet);
    paintGate();
    if (remembered && wallet.name === remembered && !state.wallet) connect(wallet, true);
  });
  paintGate();
  // Extensions can finish loading after this page does.
  setTimeout(paintGate, 1500);
}
start();
