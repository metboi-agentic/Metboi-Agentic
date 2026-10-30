// Publishes the agent skill under web/.well-known so `npx skills add https://metboi.com` can install it.
import fs from 'node:fs';
import path from 'node:path';

const NAME = 'metboi-agentic';
const source = new URL(`../skills/${NAME}/`, import.meta.url).pathname;
const root = new URL('../web/.well-known/skills/', import.meta.url).pathname;
const FILES = ['SKILL.md', 'references/setup.md', 'scripts/metboi.sh'];

fs.rmSync(root, { recursive: true, force: true });
for (const file of FILES) {
  const target = path.join(root, NAME, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(source, file), target);
}
const description = fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8').match(/^description: (.+)$/m)[1];
fs.writeFileSync(path.join(root, 'index.json'), `${JSON.stringify({ skills: [{ name: NAME, description, files: FILES }] }, null, 2)}\n`);
console.log('published', FILES.length, 'files');
