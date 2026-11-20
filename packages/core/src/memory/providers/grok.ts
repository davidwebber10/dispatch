import fs from 'node:fs';
import path from 'node:path';
import { privsep } from '../../privsep/config.js';
import { ensureDirInside, listInside, readInside, removeInside, sha, writeInside, type Root } from './safe-fs.js';
import { fileSlug, frontmatter, oneLine, type MemoryProvider, type ProviderEntry, type ProviderScope } from './types.js';

/**
 * Grok CLI's memory (experimental, off by default: `GROK_MEMORY=1` or `[memory] enabled = true` in
 * `~/.grok/config.toml`): `~/.grok/memory-v2/global/` and `workspaces/<slug>-<hash8>/`. `topics/*.md`
 * is the place to write; its generated `MEMORY.md` is never edited (and is not an entry). A project's
 * workspace is the one folder whose name is the project folder's name plus a dash and 8 characters;
 * when there is not exactly one, the project has no Grok entries.
 */
export function grokProvider(deps: { home: string; env?: NodeJS.ProcessEnv }): MemoryProvider {
  const env = deps.env ?? process.env;
  const grokDir = path.join(deps.home, '.grok');
  const base = path.join(grokDir, 'memory-v2');
  const root: Root = { dir: base, base: deps.home };
  const enabled = (): boolean => {
    if (env.GROK_MEMORY === '1') return true;
    const cfg = readInside({ dir: grokDir, base: deps.home }, 'config.toml')?.text ?? '';
    const m = /^\s*\[memory\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(cfg);
    return !!m && /^\s*enabled\s*=\s*true\b/m.test(m[1]);
  };
  const folderOf = (scope: ProviderScope): string | null => {
    if (scope.scope === 'you') return 'global';
    const name = path.basename(scope.workingDir).toLowerCase();
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(path.join(base, 'workspaces'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return null; }
    const hits = dirs.filter((d) => d.toLowerCase().startsWith(`${name}-`) && /^[0-9a-f]{8}$/i.test(d.slice(name.length + 1)));
    return hits.length === 1 ? `workspaces/${hits[0]}` : null;
  };
  const entryOf = (rel: string): ProviderEntry | null => {
    const f = readInside(root, rel);
    if (!f) return null;
    const { fields, body } = frontmatter(f.text);
    const first = body.split('\n').find((l) => l.trim()) ?? '';
    return { rel, title: fields.name || fields.title || path.basename(rel, '.md'), description: oneLine(fields.description || first.replace(/^#+\s*/, '')), text: f.text, sha: sha(f.text), mtimeMs: f.mtimeMs, writable: true };
  };
  const refuse = (error: string) => ({ ok: false as const, conflict: false as const, error });
  return {
    id: 'grok',
    label: 'Grok',
    capabilities: { scopes: ['you', 'project'], write: 'memory', delete: true, loadedByHarness: true },
    status() {
      if (!fs.existsSync(grokDir)) return { native: true, state: 'not-installed', location: null };
      return { native: true, state: enabled() ? 'on' : 'off', location: base };
    },
    list(scope) {
      const folder = folderOf(scope);
      return folder ? listInside(root, `${folder}/topics`, (n) => n.endsWith('.md')).map(entryOf).filter((e): e is ProviderEntry => !!e) : [];
    },
    read(scope, rel) {
      const folder = folderOf(scope);
      return folder && rel.startsWith(`${folder}/topics/`) ? entryOf(rel) : null;
    },
    write(scope, entry, expectedSha) {
      if (privsep()) return refuse('Dispatch does not write harness memory on a hosted box.');
      if (!enabled()) return refuse('Grok memory is off. Turn it on in Grok first.');
      const folder = folderOf(scope);
      if (!folder) return refuse('This project has no Grok memory folder yet.');
      if (entry.rel) {
        const current = this.read(scope, entry.rel);
        if (!current || current.sha !== expectedSha) return { ok: false, conflict: true, current };
        writeInside(root, entry.rel, entry.text);
        return { ok: true, rel: entry.rel };
      }
      if (!ensureDirInside(grokDir, path.join(base, folder, 'topics'))) return refuse('The Grok memory folder is not usable.');
      let rel = `${folder}/topics/${fileSlug(entry.title)}.md`;
      for (let n = 2; readInside(root, rel); n++) rel = `${folder}/topics/${fileSlug(entry.title)}-${n}.md`;
      writeInside(root, rel, `# ${oneLine(entry.title, 80)}\n\n${entry.text.trim()}\n`);
      return { ok: true, rel };
    },
    remove(scope, rel, expectedSha) {
      if (privsep()) return refuse('Dispatch does not write harness memory on a hosted box.');
      const current = this.read(scope, rel);
      if (!current || current.sha !== expectedSha) return { ok: false, conflict: true, current };
      removeInside(root, rel);
      return { ok: true, rel };
    },
  };
}
