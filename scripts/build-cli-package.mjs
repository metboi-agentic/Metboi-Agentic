// Packs the CLI into web/, so it installs from the site. package.json "files" is the allowlist of what ships.
// The tarball carries npm-shrinkwrap.json, so every install gets the same dependency tree.
// metboi-<version>.tgz never changes once published. metboi.tgz is an alias for the newest one.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const name = `metboi-${pkg.version}.tgz`;
const pointers = ['web/index.html', 'skills/metboi-agentic/references/setup.md'];
for (const file of pointers) {
  if (!fs.readFileSync(path.join(root, file), 'utf8').includes(name)) throw new Error(`${file} does not point to ${name}`);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'metboi-pack-'));
try {
  for (const item of pkg.files) fs.cpSync(path.join(root, item), path.join(work, item), { recursive: true });
  const { devDependencies: _dev, scripts: _scripts, ...shipped } = pkg;
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ ...shipped, files: [...pkg.files, 'npm-shrinkwrap.json'] }, null, 2));
  const npm = (...args) => execFileSync('npm', args, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  npm('install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund');
  npm('shrinkwrap');
  const [{ filename, files }] = JSON.parse(npm('pack', '--json', '--silent'));
  const FORBIDDEN = /(^|\/)(keys|\.env|target|test|devnet\.json|mainnet\.json)/;
  const bad = files.filter((f) => FORBIDDEN.test(f.path));
  if (bad.length) throw new Error(`Refusing to publish: ${bad.map((f) => f.path).join(', ')}`);
  if (!files.some((f) => f.path === 'npm-shrinkwrap.json')) throw new Error('The tarball has no npm-shrinkwrap.json');
  const bytes = fs.readFileSync(path.join(work, filename));
  fs.writeFileSync(path.join(root, 'web', name), bytes);
  fs.writeFileSync(path.join(root, 'web/metboi.tgz'), bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(root, 'web', `${name}.sha256`), `${sha256}  ${name}\n`);
  console.log(name, sha256, `${files.length} files`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
