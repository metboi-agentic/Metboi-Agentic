// Bundles the console into web/ and points console.html at a content-hashed URL, so a CDN never serves an old copy.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';

const root = new URL('..', import.meta.url).pathname;
const outfile = path.join(root, 'web/console.bundle.js');
await esbuild.build({
  entryPoints: [path.join(root, 'console-src/app.mjs')], bundle: true, minify: true, format: 'iife', platform: 'browser', target: 'es2020', outfile,
  define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"' }, legalComments: 'none', logLevel: 'error',
});
const stamp = (file) => createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex').slice(0, 12);
const bytes = fs.readFileSync(outfile);
const hash = stamp('web/console.bundle.js');
const edits = [
  ['web/console.html', /console\.bundle\.js(\?v=[0-9a-z.]+)?/, `console.bundle.js?v=${hash}`],
  ['web/console.html', /styles\.css(\?v=[0-9a-z.]+)?/, `styles.css?v=${stamp('web/styles.css')}`],
  ['web/index.html', /styles\.css(\?v=[0-9a-z.]+)?/, `styles.css?v=${stamp('web/styles.css')}`],
];
for (const [file, pattern, next] of edits) {
  const html = fs.readFileSync(path.join(root, file), 'utf8');
  if (!pattern.test(html)) throw new Error(`${file} does not load ${next}`);
  fs.writeFileSync(path.join(root, file), html.replace(pattern, next));
}
console.log(`console.bundle.js ${(bytes.length / 1024).toFixed(0)} KB ${hash}`);
