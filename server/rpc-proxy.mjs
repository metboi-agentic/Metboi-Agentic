// Same-origin JSON-RPC gateway for the console. It keeps the RPC key off the site, and allows only the reads the page needs.
// Wallets send transactions themselves, so sendTransaction is not on the list.

const ALLOWED = new Set([
  'getLatestBlockhash', 'getMultipleAccounts', 'getTokenAccountsByOwner', 'getMinimumBalanceForRentExemption',
  'simulateTransaction', 'getSignatureStatuses', 'getSignaturesForAddress', 'getTransaction',
]);
const MAX_BODY = 16 * 1024;
const MAX_RESPONSE = 4 * 1024 * 1024;
const WINDOW_MS = 60_000;

/** Refuses requests much larger than anything the console sends. */
function paramsOk(method, params) {
  if (!Array.isArray(params)) return false;
  if (method === 'getMultipleAccounts') return Array.isArray(params[0]) && params[0].length <= 100;
  if (method === 'getSignatureStatuses') return Array.isArray(params[0]) && params[0].length <= 10;
  if (method === 'getSignaturesForAddress') return Number.isInteger(params[1]?.limit) && params[1].limit <= 50;
  return true;
}

async function readCapped(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.length;
    if (size > MAX_RESPONSE) {
      await reader.cancel();
      throw new Error('Response too large');
    }
    chunks.push(value);
  }
}

/** Returns a request handler. upstream never appears in a response. */
export function createRpcHandler({ upstream, allowedOrigins = [], perIp = 180, simulatePerIp = 40, total = 2_000, maxInFlight = 40, fetchImpl = fetch, now = Date.now }) {
  let windowStart = now(), totalCount = 0, inFlight = 0;
  const counts = new Map(), simulations = new Map();
  /** Refused requests do not use up the shared total, so one busy address cannot lock everyone out. */
  const overLimit = (ip, method) => {
    if (now() - windowStart >= WINDOW_MS) {
      windowStart = now();
      totalCount = 0;
      counts.clear();
      simulations.clear();
    }
    if (totalCount >= total) return true;
    const used = counts.get(ip) ?? 0;
    if (used >= perIp) return true;
    if (method === 'simulateTransaction') {
      const simulated = simulations.get(ip) ?? 0;
      if (simulated >= simulatePerIp) return true;
      simulations.set(ip, simulated + 1);
    }
    counts.set(ip, used + 1);
    totalCount += 1;
    return false;
  };
  const reply = (res, status, id, message) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message } }));
  };
  return (req, res) => {
    if (req.method !== 'POST') return reply(res, 405, null, 'Use POST');
    // Browsers send Origin on every POST, so a missing one is not this page.
    if (allowedOrigins.length && !allowedOrigins.includes(req.headers.origin)) return reply(res, 403, null, 'Origin not allowed');
    const ip = req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
    const chunks = [];
    let size = 0, tooBig = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) tooBig = true;
      else chunks.push(chunk);
    });
    req.on('end', async () => {
      if (tooBig) return reply(res, 413, null, 'Request too large');
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reply(res, 400, null, 'Invalid JSON');
      }
      if (Array.isArray(body) || !ALLOWED.has(body?.method)) return reply(res, 403, body?.id, 'Method not allowed');
      const params = body.params ?? [];
      if (!paramsOk(body.method, params)) return reply(res, 400, body.id, 'Request too broad');
      if (overLimit(ip, body.method)) return reply(res, 429, body.id, 'Too many requests. Wait a minute and try again.');
      if (inFlight >= maxInFlight) return reply(res, 503, body.id, 'The console is busy. Try again.');
      inFlight += 1;
      try {
        const upstreamRes = await fetchImpl(upstream, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000),
          body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, method: body.method, params }),
        });
        if (!upstreamRes.ok) return reply(res, 502, body.id, 'The RPC is busy. Try again.');
        const bytes = await readCapped(upstreamRes);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(bytes);
      } catch {
        reply(res, 502, body.id, 'The RPC could not be reached. Try again.');
      } finally {
        inFlight -= 1;
      }
    });
  };
}
