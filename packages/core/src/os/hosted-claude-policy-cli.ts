// packages/core/src/os/hosted-claude-policy-cli.ts
// Image build step: `node hosted-claude-policy-cli.js <policy source dir> <output dir>`.
// Copies every file of the source dir to the output dir; a Claude Code managed settings file gets the
// hosted spinner words (os/hosted-claude-policy.ts). Fails the build when the word set is missing.
import fs from 'node:fs';
import path from 'node:path';
import { completeClaudePolicies, CLAUDE_POLICY_FILE } from './hosted-claude-policy.js';
import { HOSTED_WORD_SET, hostedSpinnerVerbs, webWordSetsFile } from '../settings/word-sets.js';

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('usage: hosted-claude-policy-cli.js <policy source dir> <output dir>');
  process.exit(2);
}
const verbs = hostedSpinnerVerbs();
if (!verbs) {
  console.error(`the word set ${HOSTED_WORD_SET} was not found in ${webWordSetsFile()}`);
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });
const claude: Record<string, Record<string, unknown>> = {};
for (const name of fs.readdirSync(src)) {
  const from = path.join(src, name);
  if (!fs.statSync(from).isFile()) continue;
  if (CLAUDE_POLICY_FILE.test(name)) claude[name] = JSON.parse(fs.readFileSync(from, 'utf8'));
  else fs.copyFileSync(from, path.join(out, name));
}
for (const [name, doc] of Object.entries(completeClaudePolicies(claude, verbs))) {
  fs.writeFileSync(path.join(out, name), `${JSON.stringify(doc, null, 2)}\n`);
}
console.log(`hosted policy: ${Object.keys(claude).length} Claude Code file(s) with the ${HOSTED_WORD_SET} words (${verbs.verbs.length})`);
