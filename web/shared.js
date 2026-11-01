// Formatting and the devnet transcript used by both pages.
(function () {
  const d = window.DEVNET;
  const short = (s, n = 4) => `${s.slice(0, n)}…${s.slice(-n)}`;
  const explorer = (kind, id) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
  const fmt = (raw, decimals, max = 4) => (Number(raw) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: max });
  const WSOL = 'So11111111111111111111111111111111111111112';
  const tokenName = (mint) => (mint === WSOL ? 'wSOL' : d.tokenNames[mint] ?? short(mint));
  const tokenDecimals = (mint) => (mint === WSOL ? 9 : 6);

  // Spend values come from the vault meters and the amounts the devnet run sent.
  const tx = (name) => d.events[name];
  const transcript = [
    { tag: 'owner', label: 'OWNER', who: 'owner', cmd: 'metboi init --agent <agent> --policy policy.json --broadcast', what: 'Vault created and funded', sig: tx('vault_initialize').signature },
    { tag: 'no', label: 'REFUSED', who: 'agent', cmd: '# crafted tx: swap with its output set to another account', what: 'Send swap output to another account', err: 'AccountNotOwnedByWallet' },
    { tag: 'no', label: 'REFUSED', who: 'agent', cmd: '# crafted tx: token transfer out of the wallet', what: 'Transfer wSOL straight out of the wallet', err: 'InstructionNotAllowed' },
    { tag: 'no', label: 'REFUSED', who: 'agent', cmd: '# crafted tx: withdraw_sol signed by the agent key', what: 'Agent key tries to withdraw SOL', err: 'Unauthorized' },
    { tag: 'no', label: 'REFUSED', who: 'agent', cmd: 'metboi dlmm-swap --pool <pool> --amount 40000000 --side y-to-x --broadcast', what: 'Swap 0.04 wSOL, limit is 0.03 per trade', err: 'TxCapExceeded' },
    { tag: 'ok', label: 'ALLOWED', who: 'agent', cmd: 'metboi dlmm-swap --pool <pool> --amount 10000000 --side y-to-x --broadcast', what: 'DLMM swap, 0.01 wSOL to TEST', sig: tx('agent_dlmm_swap').signature, spend: { wsol: 0.01 } },
    { tag: 'ok', label: 'ALLOWED', who: 'agent', cmd: 'metboi damm-swap --pool <pool> --input-mint <wSOL> --amount 5000000 --broadcast', what: 'DAMM v2 swap, 0.005 wSOL to TEST', sig: tx('agent_damm_swap').signature, spend: { wsol: 0.005 } },
    { tag: 'ok', label: 'ALLOWED', who: 'agent', cmd: 'metboi dlmm-open --pool <pool> --x 5000000 --y 5000000 --bins 5 --broadcast', what: 'Open DLMM position, 5 TEST and 0.005 wSOL', sig: tx('agent_dlmm_open').signature, spend: { wsol: 0.005, test: 5 } },
    { tag: 'ok', label: 'ALLOWED', who: 'agent', cmd: 'metboi dlmm-close --pool <pool> --position <position> --broadcast', what: 'Close position, funds back in the wallet', sig: tx('agent_dlmm_close').signature },
    { tag: 'owner', label: 'OWNER', who: 'owner', cmd: 'metboi pause --broadcast', what: 'Agent paused', sig: tx('owner_pause').signature },
    { tag: 'no', label: 'REFUSED', who: 'agent', cmd: 'metboi dlmm-swap --pool <pool> --amount 1000000 --side y-to-x --broadcast', what: 'Swap while paused', err: 'Paused' },
    { tag: 'owner', label: 'OWNER', who: 'owner', cmd: 'metboi resume --broadcast', what: 'Agent resumed', sig: tx('owner_resume').signature },
  ];
  const rowHtml = (r) => `
    <span class="tag ${r.tag}">${r.label}</span>
    <span class="what">${r.what}</span>
    <span class="detail">${r.err ? `<span class="err">${r.err}</span>` : `<a href="${explorer('tx', r.sig)}" target="_blank" rel="noopener">${short(r.sig)}</a>`}</span>`;
  document.querySelectorAll('[data-logo]').forEach((el) => { el.innerHTML = '<img src="assets/logo.png" alt="" width="40" height="36">'; });
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.MA = { still, d, short, explorer, fmt, WSOL, tokenName, tokenDecimals, transcript, rowHtml };
})();
