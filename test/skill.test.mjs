// Keeps the agent skill honest: valid format, real commands, no owner commands for the agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DIR = 'skills/metboi-agentic';
const skill = fs.readFileSync(`${DIR}/SKILL.md`, 'utf8');
const MAX_DESCRIPTION = 1024;
const OWNER = ['init', 'policy', 'pause', 'resume', 'set-agent', 'withdraw-sol', 'withdraw-token', 'owner-scan', 'owner-dlmm-close', 'owner-damm-close', 'owner-limit-cancel'];

async function cliCommands() {
  const { stderr } = await run('node', ['bin/metboi.mjs']).catch((e) => e);
  return stderr.match(/metboi <([^>]+)>/)[1].split('|');
}
const tableCommands = () => [...skill.matchAll(/^\| [^|]+ \| `([a-z-]+)[^`]*` \|$/gm)].map((m) => m[1]);

test('frontmatter follows the Agent Skills format', () => {
  const block = skill.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(block, 'frontmatter is present');
  const name = block[1].match(/^name: (.+)$/m)[1];
  const description = block[1].match(/^description: (.+)$/m)[1];
  assert.equal(name, DIR.split('/').pop(), 'name matches the directory');
  assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(description.length <= MAX_DESCRIPTION);
});

test('every command in the skill exists in the CLI, and every agent command is documented', async () => {
  const cli = await cliCommands();
  const documented = tableCommands();
  for (const c of documented) assert.ok(cli.includes(c), `${c} is not a CLI command`);
  for (const c of cli.filter((x) => !OWNER.includes(x))) assert.ok(documented.includes(c), `${c} is not documented`);
});

test('owner commands are forbidden in the skill and left out of its command table', () => {
  const documented = tableCommands();
  for (const c of OWNER) {
    assert.ok(!documented.includes(c), `${c} must not be an agent command`);
    assert.ok(skill.includes(`\`${c}\``), `${c} should be named in the rules`);
  }
});

test('every vault error is explained', () => {
  const source = fs.readFileSync('programs/metboi-agentic/src/error.rs', 'utf8');
  const internal = new Set(['MalformedInstruction', 'InvalidPolicy', 'AgentIsOwner', 'SenderNotWallet', 'NotAPositionNft', 'WalletCorrupted', 'TargetNotAllowed']);
  for (const [, name] of source.matchAll(/^\s+([A-Z]\w+),$/gm)) {
    if (!internal.has(name)) assert.ok(skill.includes(`\`${name}\``), `${name} is missing from the error table`);
  }
});

test('the wrapper reports missing setup as JSON instead of failing silently', async () => {
  const env = { PATH: process.env.PATH, METBOI_ENV_FILE: '/nonexistent/file' };
  const out = await run('sh', [`${DIR}/scripts/metboi.sh`, 'status'], { env }).catch((e) => e);
  assert.equal(out.code, 2);
  assert.equal(JSON.parse(out.stdout).ok, false);
});

test('the wrapper runs the CLI from METBOI_HOME', async () => {
  const env = { PATH: process.env.PATH, METBOI_HOME: process.cwd() };
  const out = await run('sh', [`${DIR}/scripts/metboi.sh`, 'status'], { env }).catch((e) => e);
  assert.match(JSON.parse(out.stdout).error, /METBOI_RPC/, 'it reaches the CLI, which reports the missing setting as JSON on stdout');
  assert.equal(out.code, 1);
});

test('the shipped IDL matches the build', () => {
  assert.equal(fs.readFileSync('idl/metboi_agentic.json', 'utf8'), fs.readFileSync('target/idl/metboi_agentic.json', 'utf8'));
});

test('the skill holds no secrets or machine paths', () => {
  const files = [`${DIR}/SKILL.md`, `${DIR}/references/setup.md`, `${DIR}/scripts/metboi.sh`];
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /api-key=|helius|\/Users\/|\[\d+,\s*\d+,\s*\d+/i, f);
});
