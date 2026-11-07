import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Marketplaces (docs/superpowers/specs/2026-11-07-plugins-design.md, section 7.1): a marketplace
 * is a git repository. The daemon keeps one clone per marketplace under `dir/<slug>` and a list in
 * `stateFile`; it clones and pulls with the owner's own git credentials (ssh keys, the credential
 * helper) and never stores a token. The catalog is what the clone's HEAD holds; older versions
 * are in the history of `plugins/<id>/plugin.json`.
 */
export interface Marketplace { url: string; slug: string; name: string | null; description: string | null; trusted: boolean; addedAt: string; lastPulledAt: string | null; error: string | null }
export interface CatalogEntry { marketplace: string; kind: 'plugin' | 'skill'; id: string; name: string; version: string; description: string | null; dispatch?: string; sdk?: number; changelog: string | null; folder: string }
export interface MarketVersion { version: string; commit: string; date: string }

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const GIT_TIMEOUT_MS = 120_000;
const MAX_OUT = 64 * 1024 * 1024;

/** The URL shapes a marketplace may have. Anything else (a flag, a relative path, whitespace) is refused before git sees it. */
export function isMarketplaceUrl(url: string): boolean {
  if (typeof url !== 'string' || !url || /[\s\x00-\x1f]/.test(url) || url.startsWith('-')) return false;
  return /^https?:\/\/[^/]+\/.+/.test(url) || /^ssh:\/\/[^/]+\/.+/.test(url) || /^git@[\w.-]+:.+/.test(url) || /^file:\/\/\/.+/.test(url) || path.isAbsolute(url);
}

/** A folder name from the URL: the host and path, lowercased, with a short hash so two spellings never collide. */
export function slugOf(url: string): string {
  const h = createHash('sha256').update(url).digest('hex').slice(0, 6);
  const text = url.replace(/^[a-z+]+:\/\//i, '').replace(/^git@/, '').replace(/\.git\/?$/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return `${text.slice(0, 48) || 'market'}-${h}`;
}

function runGit(args: string[], cwd: string): Promise<{ ok: boolean; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
    try {
      const child = execFile('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_OUT, encoding: 'buffer' }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? '')), stderr: String(stderr ?? '') });
      });
      child.stdin?.end();
    } catch (e) { resolve({ ok: false, stdout: Buffer.alloc(0), stderr: e instanceof Error ? e.message : String(e) }); }
  });
}
/** Git's last meaningful line: what the owner reads on the Plugins page. */
const lastLine = (stderr: string): string => stderr.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? 'git failed';

export class MarketplaceService {
  constructor(readonly dir: string, private readonly stateFile: string) {}

  list(): Marketplace[] { return this.readState(); }

  get(slug: string): Marketplace | null { return this.readState().find((m) => m.slug === slug) ?? null; }

  /** Add a marketplace and clone it. A failed clone keeps the row with git's message; pull retries. */
  async add(url: string): Promise<Marketplace> {
    if (!isMarketplaceUrl(url)) throw new Error('not a marketplace url: use https://, ssh://, git@host:path, or an absolute path');
    const existing = this.readState().find((m) => m.url === url);
    if (existing) return existing;
    const row: Marketplace = { url, slug: slugOf(url), name: null, description: null, trusted: false, addedAt: new Date().toISOString(), lastPulledAt: null, error: null };
    this.writeState([...this.readState(), row]);
    return this.pull(row.slug);
  }

  remove(slug: string): void {
    const rows = this.readState();
    if (!rows.some((m) => m.slug === slug)) throw new Error('unknown marketplace');
    this.writeState(rows.filter((m) => m.slug !== slug));
    fs.rmSync(this.cloneDir(slug), { recursive: true, force: true });
  }

  setTrusted(slug: string, on: boolean): Marketplace {
    const rows = this.readState();
    const row = rows.find((m) => m.slug === slug);
    if (!row) throw new Error('unknown marketplace');
    row.trusted = on;
    this.writeState(rows);
    return row;
  }

  /** Clone when the clone is missing, else fast-forward it. Git's own last line lands on the row when it fails. */
  async pull(slug: string): Promise<Marketplace> {
    const row = this.get(slug);
    if (!row) throw new Error('unknown marketplace');
    const clone = this.cloneDir(slug);
    let r: { ok: boolean; stderr: string };
    if (!fs.existsSync(path.join(clone, '.git'))) {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.rmSync(clone, { recursive: true, force: true });
      r = await runGit(['clone', '--quiet', '--', row.url, clone], this.dir);
    } else {
      r = await runGit(['pull', '--quiet', '--ff-only'], clone);
    }
    const rows = this.readState();
    const live = rows.find((m) => m.slug === slug)!;
    if (r.ok) {
      live.error = null; live.lastPulledAt = new Date().toISOString();
      const meta = this.readJson(path.join(clone, 'marketplace.json'));
      live.name = typeof meta?.name === 'string' ? meta.name : live.name;
      live.description = typeof meta?.description === 'string' ? meta.description : live.description;
    } else {
      live.error = lastLine(r.stderr);
    }
    this.writeState(rows);
    return live;
  }

  async pullAll(): Promise<Marketplace[]> {
    const out: Marketplace[] = [];
    for (const m of this.readState()) out.push(await this.pull(m.slug));
    return out;
  }

  /** Every plugin and skill at every clone's HEAD, plugins first, in id order per marketplace. */
  async catalog(): Promise<CatalogEntry[]> {
    const out: CatalogEntry[] = [];
    for (const m of this.readState()) {
      const clone = this.cloneDir(m.slug);
      if (!fs.existsSync(path.join(clone, '.git'))) continue;
      for (const kind of ['plugin', 'skill'] as const) {
        const base = path.join(clone, kind === 'plugin' ? 'plugins' : 'skills');
        let ids: string[] = [];
        try { ids = fs.readdirSync(base).filter((n) => ID_RE.test(n)).sort(); } catch { continue; }
        for (const id of ids) {
          const folder = path.join(base, id);
          const meta = this.readJson(path.join(folder, kind === 'plugin' ? 'plugin.json' : 'skill.json'));
          if (!meta || typeof meta.name !== 'string' || typeof meta.version !== 'string') continue;
          let changelog: string | null = null;
          try { changelog = fs.readFileSync(path.join(folder, 'CHANGELOG.md'), 'utf8'); } catch { changelog = null; }
          out.push({
            marketplace: m.slug, kind, id, name: meta.name, version: meta.version, description: typeof meta.description === 'string' ? meta.description : null,
            ...(typeof meta.dispatch === 'string' ? { dispatch: meta.dispatch } : {}), ...(typeof meta.sdk === 'number' ? { sdk: meta.sdk } : {}), changelog, folder,
          });
        }
      }
    }
    return out;
  }

  /** The versions a plugin had, newest first: one entry per version, at the newest commit that carried it. */
  async versions(slug: string, id: string, kind: 'plugin' | 'skill' = 'plugin'): Promise<MarketVersion[]> {
    if (!ID_RE.test(id)) return [];
    const clone = this.cloneDir(slug);
    const rel = `${kind === 'plugin' ? 'plugins' : 'skills'}/${id}/${kind === 'plugin' ? 'plugin.json' : 'skill.json'}`;
    const log = await runGit(['log', '--format=%H%x09%cI', '--', rel], clone);
    if (!log.ok) return [];
    const out: MarketVersion[] = [];
    const seen = new Set<string>();
    for (const line of log.stdout.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean)) {
      const [commit, date] = line.split('\t');
      const show = await runGit(['show', `${commit}:${rel}`], clone);
      if (!show.ok) continue;
      let version: string | null = null;
      try { const v = JSON.parse(show.stdout.toString('utf8')) as { version?: unknown }; version = typeof v.version === 'string' ? v.version : null; } catch { version = null; }
      if (!version || seen.has(version)) continue;
      seen.add(version);
      out.push({ version, commit, date });
    }
    return out;
  }

  /**
   * The plugin (or skill) folder as it was at a commit (HEAD by default), exported into a fresh
   * temp folder: `ls-tree` + `show` per file, so the clone's own work tree and index stay as they are.
   */
  async folderAt(slug: string, id: string, commit = 'HEAD', kind: 'plugin' | 'skill' = 'plugin'): Promise<string> {
    if (!ID_RE.test(id)) throw new Error('bad id');
    if (!/^[A-Za-z0-9_./-]+$/.test(commit) || commit.startsWith('-')) throw new Error('bad commit');
    const clone = this.cloneDir(slug);
    const rel = `${kind === 'plugin' ? 'plugins' : 'skills'}/${id}`;
    const tree = await runGit(['ls-tree', '-r', '--name-only', '-z', commit, '--', rel], clone);
    if (!tree.ok) throw new Error(`cannot read ${rel} at ${commit}: ${lastLine(tree.stderr)}`);
    const files = tree.stdout.toString('utf8').split('\0').filter(Boolean);
    if (files.length === 0) throw new Error(`no ${kind} "${id}" at ${commit}`);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), `dispatch-${kind}-${id}-`));
    for (const f of files) {
      const inside = path.relative(rel, f);
      if (inside.startsWith('..') || path.isAbsolute(inside)) continue;
      const show = await runGit(['show', `${commit}:${f}`], clone);
      if (!show.ok) throw new Error(`cannot read ${f} at ${commit}`);
      const dest = path.join(out, inside);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, show.stdout);
    }
    return out;
  }

  /** HEAD of a clone, for the install record. */
  async head(slug: string): Promise<string | null> {
    const r = await runGit(['rev-parse', 'HEAD'], this.cloneDir(slug));
    return r.ok ? r.stdout.toString('utf8').trim() : null;
  }

  cloneDir(slug: string): string { return path.join(this.dir, slug); }

  private readJson(file: string): Record<string, unknown> | null {
    try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v as Record<string, unknown> : null; } catch { return null; }
  }
  private readState(): Marketplace[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as { marketplaces?: unknown };
      return Array.isArray(raw.marketplaces) ? raw.marketplaces.filter((m): m is Marketplace => !!m && typeof m === 'object' && typeof (m as Marketplace).url === 'string' && typeof (m as Marketplace).slug === 'string') : [];
    } catch { return []; }
  }
  private writeState(rows: Marketplace[]): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify({ marketplaces: rows }, null, 2) + '\n', { mode: 0o600 });
  }
}
