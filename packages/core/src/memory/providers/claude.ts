import fs from 'node:fs';
import path from 'node:path';
import { claudeMemoryProjectDir, sharedProjectMemoryDir } from '../../overseer/memory-scope.js';
import { privsep } from '../../privsep/config.js';
import { ensureDirInside, listInside, readInside, removeInside, sha, writeInside } from './safe-fs.js';
import { fileSlug, frontmatter, oneLine, type EntryWrite, type MemoryProvider, type ProviderEntry, type ProviderScope, type WriteResult } from './types.js';

/**
 * Claude Code's own memory (https://code.claude.com/docs/en/memory): per repository,
 * `~/.claude/projects/<repo>/memory/`, a `MEMORY.md` index (Claude Code loads its first 200 lines or
 * 25 KB) and one markdown file per memory with frontmatter (`name`, `description`, `metadata.type`).
 * On by default. A file written from outside survives. `MEMORY.md` itself is never an entry.
 *
 * Writes: a new entry is a new file plus ONE line appended to the index (the index is never rewritten
 * otherwise); refused when the index is near 200 lines. A delete removes the file and its index line.
 */
export const INDEX = 'MEMORY.md';
export const INDEX_LIMIT = 190;

export interface ClaudeDeps {
  home: string;
  env?: NodeJS.ProcessEnv;
  /** Claude's folder key for a working directory (default: git's main root, overseer/memory-scope.ts). */
  projectDir?: (workDir: string) => string | null;
}

export function claudeProvider(deps: ClaudeDeps): MemoryProvider {
  const env = deps.env ?? process.env;
  const projectDir = deps.projectDir ?? ((w: string) => claudeMemoryProjectDir(w).dir);
  const projectsRoot = path.join(deps.home, '.claude', 'projects');
  const rootOf = (scope: ProviderScope): string | null => {
    if (scope.scope === 'you') return null;
    let dir: string | null = null;
    try { dir = projectDir(scope.workingDir); } catch { /* git failed: no folder this time */ }
    return dir ? sharedProjectMemoryDir(deps.home, dir) : null;
  };
  const entryOf = (root: string, rel: string): ProviderEntry | null => {
    const f = readInside(root, rel);
    if (!f) return null;
    const { fields } = frontmatter(f.text);
    return { rel, title: fields.name || rel.replace(/\.md$/, ''), description: oneLine(fields.description ?? ''), text: f.text, sha: sha(f.text), mtimeMs: f.mtimeMs, writable: true };
  };
  const autoMemoryOn = (): boolean => {
    if (env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1') return false;
    const s = readInside(path.join(deps.home, '.claude'), 'settings.json');
    try { return !(s && JSON.parse(s.text)?.autoMemoryEnabled === false); } catch { return true; }
  };
  const refuseHosted = (): WriteResult | null =>
    privsep() ? { ok: false, conflict: false, error: 'Dispatch does not write harness memory on a hosted box.' } : null;

  return {
    id: 'claude',
    label: 'Claude Code',
    capabilities: { scopes: ['project'], write: 'memory', delete: true, loadedByHarness: true },
    status(scope) {
      if (!fs.existsSync(path.join(deps.home, '.claude'))) return { native: true, state: 'not-installed', location: null };
      return { native: true, state: autoMemoryOn() ? 'on' : 'off', location: scope ? rootOf(scope) : projectsRoot };
    },
    list(scope) {
      const root = rootOf(scope);
      if (!root) return [];
      return listInside(root, '', (n) => n.endsWith('.md') && n !== INDEX).map((rel) => entryOf(root, rel)).filter((e): e is ProviderEntry => !!e);
    },
    read(scope, rel) {
      const root = rootOf(scope);
      return root && rel !== INDEX ? entryOf(root, rel) : null;
    },
    write(scope, entry: EntryWrite, expectedSha) {
      const hosted = refuseHosted(); if (hosted) return hosted;
      const root = rootOf(scope);
      if (!root) return { ok: false, conflict: false, error: 'This project has no Claude Code memory folder.' };
      if (entry.rel) {
        // An edit: the file must be the one the person saw. The file always wins.
        const current = entryOf(root, entry.rel);
        if (!current || entry.rel === INDEX) return { ok: false, conflict: true, current };
        if (current.sha !== expectedSha) return { ok: false, conflict: true, current };
        writeInside(root, entry.rel, entry.text);
        return { ok: true, rel: entry.rel };
      }
      if (!ensureDirInside(projectsRoot, root)) return { ok: false, conflict: false, error: 'The Claude Code memory folder is not usable.' };
      const index = readInside(root, INDEX)?.text ?? '';
      const lines = index.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')).length;
      if (lines >= INDEX_LIMIT) return { ok: false, conflict: false, error: `Claude Code loads only the first 200 lines of its memory index, and it has ${lines}. Remove an entry first.` };
      let rel = `${fileSlug(entry.title)}.md`;
      for (let n = 2; readInside(root, rel) || rel === INDEX; n++) rel = `${fileSlug(entry.title)}-${n}.md`;
      const description = oneLine(entry.description || entry.title, 200);
      const body = `---\nname: ${oneLine(entry.title, 80)}\ndescription: ${description}\nmetadata:\n  type: user\n---\n\n${entry.text.trim()}\n`;
      writeInside(root, rel, body);
      // One appended line; the lines that are there stay as they are.
      writeInside(root, INDEX, `${index}${index && !index.endsWith('\n') ? '\n' : ''}- [${oneLine(entry.title, 80)}](${rel}) — ${description}\n`);
      return { ok: true, rel };
    },
    remove(scope, rel, expectedSha) {
      const hosted = refuseHosted(); if (hosted) return hosted;
      const root = rootOf(scope);
      const current = root && rel !== INDEX ? entryOf(root, rel) : null;
      if (!root || !current || current.sha !== expectedSha) return { ok: false, conflict: true, current };
      removeInside(root, rel);
      const index = readInside(root, INDEX)?.text;
      if (index !== undefined) {
        const kept = index.split('\n').filter((l) => !l.includes(`](${rel})`)).join('\n');
        if (kept !== index) writeInside(root, INDEX, kept);
      }
      return { ok: true, rel };
    },
  };
}
