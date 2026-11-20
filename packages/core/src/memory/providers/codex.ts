import fs from 'node:fs';
import { codexHome } from '../../platform/codex-home.js';
import { privsep } from '../../privsep/config.js';
import { listInside, readInside, sha, writeInside, type Root } from './safe-fs.js';
import { oneLine, type MemoryProvider, type ProviderEntry, type WriteResult } from './types.js';

/**
 * Codex's own memory: `$CODEX_HOME/memories_v2/` (the desktop app also `memories/`), with
 * `memory_summary.md`, `MEMORY.md`, `raw_memories.md` and `rollout_summaries/`. Off by default. Those
 * files are Codex's generated state: Dispatch only reads them.
 *
 * The place Dispatch writes is a MARKED SECTION of `$CODEX_HOME/AGENTS.md`, which Codex loads in every
 * session: the screen calls it "Codex instructions" (capability write = 'instructions'). Dispatch never
 * writes a repository's AGENTS.md.
 */
export const SECTION_START = '<!-- dispatch-memory:start -->';
export const SECTION_END = '<!-- dispatch-memory:end -->';
export const INSTRUCTIONS_REL = 'AGENTS.md#dispatch';
const MEMORY_DIRS = ['memories_v2', 'memories'];
const MEMORY_FILES = ['memory_summary.md', 'MEMORY.md', 'raw_memories.md'];

/** The marked section's text (null when there is none) and the file around it. */
export function splitSection(file: string): { before: string; body: string | null; after: string } {
  const s = file.indexOf(SECTION_START);
  const e = s < 0 ? -1 : file.indexOf(SECTION_END, s);
  if (s < 0 || e < 0) return { before: file, body: null, after: '' };
  return { before: file.slice(0, s), body: file.slice(s + SECTION_START.length, e).replace(/^\n/, '').replace(/\n$/, ''), after: file.slice(e + SECTION_END.length) };
}

const joinSection = (before: string, body: string, after: string): string => {
  const lead = before && !before.endsWith('\n') ? `${before}\n` : before;
  return `${lead}${lead && !lead.endsWith('\n\n') ? '\n' : ''}${SECTION_START}\n${body.trim()}\n${SECTION_END}${after || '\n'}`;
};

export function codexProvider(deps: { home: string; env?: NodeJS.ProcessEnv }): MemoryProvider {
  const env = deps.env ?? process.env;
  const home = () => codexHome(env, deps.home);
  // CODEX_HOME comes from the daemon's own environment: then it is the trusted folder; else the home.
  const root = (): Root => ({ dir: home(), base: env.CODEX_HOME ? home() : deps.home });
  const memoryFiles = (): string[] => MEMORY_DIRS.flatMap((d) => [
    ...listInside(root(), d, (n) => MEMORY_FILES.includes(n)),
    ...listInside(root(), `${d}/rollout_summaries`, (n) => n.endsWith('.md')),
  ]);
  const instructions = (): ProviderEntry => {
    const f = readInside(root(), 'AGENTS.md');
    const body = f ? splitSection(f.text).body ?? '' : '';
    return { rel: INSTRUCTIONS_REL, title: 'Codex instructions', description: 'The Dispatch section of ~/.codex/AGENTS.md, which Codex loads in every session', text: body, sha: sha(body), mtimeMs: f?.mtimeMs ?? 0, writable: true };
  };
  const entryOf = (rel: string): ProviderEntry | null => {
    if (rel === INSTRUCTIONS_REL) return instructions();
    if (!memoryFiles().includes(rel)) return null;
    const f = readInside(root(), rel);
    if (!f) return null;
    const first = f.text.split('\n').find((l) => l.trim()) ?? '';
    return { rel, title: rel.replace(/\.md$/, ''), description: oneLine(first.replace(/^#+\s*/, '')), text: f.text, sha: sha(f.text), mtimeMs: f.mtimeMs, writable: false };
  };
  return {
    id: 'codex',
    label: 'Codex',
    capabilities: { scopes: ['you'], write: 'instructions', delete: false, loadedByHarness: true },
    status() {
      if (!fs.existsSync(home())) return { native: true, state: 'not-installed', location: null };
      return { native: true, state: memoryFiles().length ? 'on' : 'off', location: home() };
    },
    list(scope) {
      if (scope.scope !== 'you') return [];
      const out = memoryFiles().map(entryOf).filter((e): e is ProviderEntry => !!e);
      const ins = instructions();
      return ins.text ? [ins, ...out] : out;
    },
    read(scope, rel) { return scope.scope === 'you' ? entryOf(rel) : null; },
    /**
     * No `rel` (a new entry): one line `- text` appended to the section; the same line twice is one line.
     * `rel` = the section: its whole text, when the section is the one the person saw.
     */
    write(scope, entry, expectedSha): WriteResult {
      if (privsep()) return { ok: false, conflict: false, error: 'Dispatch does not write harness memory on a hosted box.' };
      if (scope.scope !== 'you') return { ok: false, conflict: false, error: 'Codex instructions are for every project ("you").' };
      if (entry.rel && entry.rel !== INSTRUCTIONS_REL) return { ok: false, conflict: false, error: 'Codex memory files are Codex\'s own: Dispatch only reads them.' };
      if (!fs.existsSync(home())) return { ok: false, conflict: false, error: 'Codex is not installed.' };
      const file = readInside(root(), 'AGENTS.md')?.text ?? '';
      const { before, body, after } = splitSection(file);
      const current = body ?? '';
      let next: string;
      if (entry.rel) {
        if (sha(current) !== expectedSha) return { ok: false, conflict: true, current: instructions() };
        next = entry.text;
      } else {
        const line = `- ${oneLine(entry.text, 1000)}`;
        const lines = current ? current.split('\n') : [];
        if (lines.includes(line)) return { ok: true, rel: INSTRUCTIONS_REL };
        next = [...lines, line].join('\n');
      }
      if (next.trim() === current.trim() && body !== null) return { ok: true, rel: INSTRUCTIONS_REL };
      writeInside(root(), 'AGENTS.md', joinSection(before, next, after));
      return { ok: true, rel: INSTRUCTIONS_REL };
    },
  };
}
