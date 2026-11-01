(function () {
  const { d, short, explorer, fmt, WSOL, transcript, still } = window.MA;
  const $ = (id) => document.getElementById(id);
  $('paper-owner').textContent = short(d.owner);
  $('paper-agent').textContent = short(d.agent);
  $('paper-pools').innerHTML = d.pools.map((p) => `${p.venue.toLowerCase()} ${short(p.address)}`).join('<br>');
  $('foot-program').href = `https://explorer.solana.com/address/${d.program}`;
  $('foot-program').firstElementChild.textContent = d.program;

  const wsol = d.budgets.find((b) => b.mint === WSOL);
  const test = d.budgets.find((b) => b.mint === d.testMint);
  const limits = [
    { key: 'wsol', name: 'wSOL', tx: fmt(wsol.txCap, 9), day: Number(wsol.dailyCap) / 1e9 },
    { key: 'test', name: 'TEST', tx: fmt(test.txCap, 6), day: Number(test.dailyCap) / 1e6 },
  ];
  $('paper-limits').innerHTML = limits.map((l) => `
    <div class="limit">
      <div class="limit-row"><span>${l.name}</span><small>${l.tx}/trade · ${l.day.toLocaleString('en-US')}/24h</small></div>
      <div class="seg"><i id="bar-${l.key}"></i></div>
      <div class="limit-row" style="margin-top:5px"><small id="used-${l.key}">0 used</small></div>
    </div>`).join('');

  const used = { wsol: 0, test: 0 };
  const paintBudget = () => limits.forEach((l) => {
    $(`bar-${l.key}`).style.width = `${(used[l.key] / l.day) * 100}%`;
    $(`used-${l.key}`).textContent = `${used[l.key].toLocaleString('en-US', { maximumFractionDigits: 3 })} used`;
  });

  const term = $('term');
  const statusline = $('statusline');
  const statusText = $('status-text');
  const setStatus = (text, busy) => { statusText.textContent = text; statusline.classList.toggle('busy', busy); };
  const stick = () => { term.scrollTop = term.scrollHeight; };
  const verdict = (r) => {
    if (r.err) return `<span class="no">x refused</span> <span class="no">${r.err}</span>`;
    return `<span class="ok">ok</span> <small>${r.what.toLowerCase()}</small> <a href="${explorer('tx', r.sig)}" target="_blank" rel="noopener">${short(r.sig)}</a>`;
  };
  const addLine = (cls, html) => {
    const el = document.createElement('div');
    el.className = `line ${cls}`;
    el.innerHTML = html;
    term.append(el);
    stick();
    return el;
  };
  const spend = (r) => { if (r.spend) { used.wsol += r.spend.wsol ?? 0; used.test += r.spend.test ?? 0; paintBudget(); } };
  const printNow = (r) => {
    addLine('cmd-line', `<span class="who ${r.who}">${r.who} ›</span><span class="typed"></span>`).querySelector('.typed').textContent = r.cmd;
    addLine('res', verdict(r));
    spend(r);
  };

  if (still()) { transcript.forEach(printNow); term.scrollTop = 0; setStatus('replay finished', false); return; }

  // Holds the replay while it is off screen, in a hidden tab, or being read.
  let onScreen = true, reading = false;
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; }).observe(term);
  for (const [on, value] of [['mouseenter', true], ['mouseleave', false], ['focusin', true], ['focusout', false]]) term.addEventListener(on, () => { reading = value; });
  const held = () => !onScreen || reading || document.hidden;
  const sleep = (ms) => new Promise((resolve) => {
    const wait = () => (held() ? setTimeout(wait, 150) : setTimeout(resolve, ms));
    wait();
  });
  const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  const TYPE_MS = 12, FRAME_MS = 80, SIM_FRAMES = 9, AFTER_MS = 650, HOLD_MS = 7000;

  async function play(r) {
    const line = addLine('cmd-line', `<span class="who ${r.who}">${r.who} ›</span><span class="typed"></span><span class="caret" aria-hidden="true"></span>`);
    const typed = line.querySelector('.typed');
    setStatus(`${r.who} is typing`, true);
    for (const c of r.cmd) {
      typed.textContent += c;
      stick();
      await sleep(TYPE_MS + Math.random() * 14);
    }
    line.querySelector('.caret').remove();
    const res = addLine('res', '<span class="spin"></span>');
    const spin = res.firstElementChild;
    setStatus('simulating', true);
    for (let f = 0; f < SIM_FRAMES; f++) {
      spin.textContent = `${SPINNER[f % SPINNER.length]} simulating`;
      await sleep(FRAME_MS);
    }
    res.innerHTML = verdict(r);
    stick();
    spend(r);
    setStatus('idle', false);
    await sleep(AFTER_MS);
  }

  const OPENING = 1; // One finished exchange, so the panel never opens empty.
  (async function loop() {
    for (;;) {
      term.textContent = '';
      used.wsol = 0; used.test = 0; paintBudget();
      transcript.slice(0, OPENING).forEach(printNow);
      await sleep(700);
      for (const r of transcript.slice(OPENING)) await play(r);
      setStatus('replay finished', false);
      await sleep(HOLD_MS);
    }
  })();
})();
