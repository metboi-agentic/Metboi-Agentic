// Starts the console's RPC gateway on the local interface. nginx sends /rpc here.
import http from 'node:http';
import { createRpcHandler } from './rpc-proxy.mjs';

const upstream = process.env.METBOI_RPC_UPSTREAM;
if (!upstream) throw new Error('Set METBOI_RPC_UPSTREAM');
const handler = createRpcHandler({ upstream, allowedOrigins: ['https://metboi.com', 'https://www.metboi.com'] });
const PORT = Number(process.env.PORT ?? 4975);
http.createServer((req, res) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/rpc') {
    res.writeHead(404);
    return res.end();
  }
  return handler(req, res);
}).listen(PORT, '127.0.0.1', () => console.log(`RPC gateway on 127.0.0.1:${PORT}`));
