// Minimal static server for previewing web/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('../web/', import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 4970);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  // Same clean URLs as the site: /console serves console.html.
  const clean = path.extname(pathname) ? pathname : `${pathname}.html`;
  const file = path.normalize(path.join(root, pathname === '/' ? 'index.html' : clean));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
