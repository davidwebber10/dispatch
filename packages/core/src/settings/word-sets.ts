// packages/core/src/settings/word-sets.ts
// The ready-made word sets of the "Working…" indicator are written ONCE, in the web client
// (packages/web/src/lib/spinnerWords.ts, WORD_SETS). The daemon reads a set from that file instead of
// keeping a copy: a hosted box shows the POLYWOOD set by default, and the image's Claude Code policy
// is built with the same words (os/hosted-claude-policy.ts).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpinnerVerbs } from './harness-settings.js';

/** The set a hosted box uses for its own indicator and for Claude Code's spinner. */
export const HOSTED_WORD_SET = 'POLYWOOD';

/** The web client's word-set file, from src/ (development) or dist/ (built): both sit at the same depth. */
export function webWordSetsFile(): string {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  return path.join(repoRoot, 'packages', 'web', 'src', 'lib', 'spinnerWords.ts');
}

/**
 * The words of one named set in that file's source text: `{ name: '<name>', words: [ ... ] }`.
 * Null when the set is not there or a word is not a plain quoted string.
 */
export function parseWordSet(source: string, name: string): string[] | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`\\{\\s*name:\\s*(['"])${esc}\\1\\s*,\\s*words:\\s*\\[([^\\]]*)\\]`).exec(source);
  if (!m) return null;
  const words: string[] = [];
  const item = /\s*(['"])((?:(?!\1)[^\\\n])*)\1\s*(?:,|$)/y;
  const body = m[2].trim();
  let pos = 0;
  while (pos < body.length) {
    item.lastIndex = pos;
    const w = item.exec(body);
    if (!w) return null;
    if (w[2].trim()) words.push(w[2].trim());
    pos = item.lastIndex;
  }
  return words.length ? words : null;
}

let cached: { file: string; verbs: SpinnerVerbs | null } | null = null;

/** The hosted set as Claude Code's `spinnerVerbs` (mode `replace`), or null when the file has no such set. */
export function hostedSpinnerVerbs(file: string = webWordSetsFile()): SpinnerVerbs | null {
  if (cached && cached.file === file) return cached.verbs;
  let verbs: SpinnerVerbs | null = null;
  try {
    const words = parseWordSet(fs.readFileSync(file, 'utf8'), HOSTED_WORD_SET);
    verbs = words ? { mode: 'replace', verbs: words } : null;
  } catch { verbs = null; }
  cached = { file, verbs };
  return verbs;
}
