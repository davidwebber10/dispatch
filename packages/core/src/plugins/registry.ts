import fs from 'node:fs';
import path from 'node:path';
import type { EventBroadcaster } from '../ws/events.js';
import type { KeyRegistry } from '../auth/principals.js';
import type { PluginFacts } from '../auth/plugin-facts.js';
import type { McpServerSpec } from '../mcp/injection.js';
import { PLUGIN_ID_RE, parseManifest, satisfiesDispatch, type PluginManifest } from './manifest.js';
import { pluginTemplate } from './template.js';

/**
 * Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md, sections 1 and 2.1): the folders
 * under ~/.dispatch/plugins, one plugin each. The registry lists them with their state, keeps
 * the enabled list in plugins.json beside the folder, confines file reads to a plugin's real
 * folder, scaffolds and removes local plugins, and watches the folder so the web client can
 * reload a plugin as its author saves (`plugin:changed`).
 */
export interface PluginInstall { marketplace: string; version: string; sha256: string; installedAt: string }

export interface PluginRow extends Partial<PluginManifest> {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  /** The newest mtime among the folder, plugin.json and the web bundle (ms): the bundle's cache-busting version. */
  stamp: number;
  /** Set when the folder is not a loadable plugin; such a row is never enabled. */
  error?: string;
  /** The install record a marketplace install wrote; null for a local plugin. */
  install: PluginInstall | null;
  /** True while the plugin holds a live key (enabled and not broken). */
  keyed: boolean;
  /** Hook script counters, when the daemon runs hooks (slice 3). */
  hooks?: { runs: number; failures: number; dropped: number };
  /** The assist meter, once the plugin made a call. */
  assist?: { calls: number; inputTokens: number; outputTokens: number };
  /** Served from the Dispatch checkout (spec section 10): updates with Dispatch, cannot be removed. */
  bundled?: boolean;
  /** A local folder with this id hides a bundled plugin of the same id. */
  shadowsBundled?: boolean;
}

const DEBOUNCE_MS = 150;
const STAMP_MAX_DEPTH = 4;
const SKIP_DIRS = new Set(['node_modules', '.git']);

/** The newest mtime of any file in the folder (a few levels deep): a change to any file the bundle imports changes the stamp. */
function newestMtime(folder: string, depth = 0): number {
  let max = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const full = path.join(folder, e.name);
    try {
      const st = fs.statSync(full);
      if (st.isDirectory()) { if (depth < STAMP_MAX_DEPTH) max = Math.max(max, newestMtime(full, depth + 1)); }
      else max = Math.max(max, st.mtimeMs);
    } catch { /* a vanished entry: skip */ }
  }
  return max;
}
const INSTALL_FILE = '.dispatch-install.json';

interface StateFile { disabled: string[] }

export class PluginRegistry {
  private watcher: fs.FSWatcher | null = null;
  /** One more watcher per symlinked plugin folder: the top-level watcher does not follow links. */
  private linkWatchers = new Map<string, fs.FSWatcher>();
  private timers = new Map<string, NodeJS.Timeout>();

  private readonly keys: KeyRegistry | null;
  private readonly keyDir: string | null;
  /** The checkout's packages/plugins, when it exists. */
  private readonly bundledDir: string | null;
  private hookStats: ((id: string) => { runs: number; failures: number; dropped: number }) | null = null;
  setHookStatsProvider(fn: (id: string) => { runs: number; failures: number; dropped: number }): void { this.hookStats = fn; }
  private assistTotals: ((id: string) => { calls: number; inputTokens: number; outputTokens: number }) | null = null;
  setAssistTotalsProvider(fn: (id: string) => { calls: number; inputTokens: number; outputTokens: number }): void { this.assistTotals = fn; }

  constructor(readonly dir: string, private readonly broadcaster: EventBroadcaster, private readonly runningVersion: string, opts: { keys?: KeyRegistry; keyDir?: string; bundledDir?: string } = {}) {
    this.keys = opts.keys ?? null;
    this.keyDir = opts.keyDir ?? null;
    this.bundledDir = opts.bundledDir ?? null;
  }

  /** Where a plugin's folder is: the local one wins over a bundled one of the same id. */
  private folderOf(id: string): { folder: string; bundled: boolean; shadows: boolean } | null {
    const local = path.join(this.dir, id);
    const bundled = this.bundledDir ? path.join(this.bundledDir, id) : null;
    const has = (p: string | null) => { try { return !!p && fs.statSync(p).isDirectory(); } catch { return false; } };
    if (has(local)) return { folder: local, bundled: false, shadows: has(bundled) };
    if (has(bundled)) return { folder: bundled!, bundled: true, shadows: false };
    return null;
  }

  // ── keys (spec section 6): one live key per enabled plugin, in ~/.dispatch/keys/plugin-<id> ──
  private keyFile(id: string): string | null { return this.keyDir ? path.join(this.keyDir, `plugin-${id}`) : null; }

  private issueKey(id: string): void {
    if (!this.keys) return;
    const { key } = this.keys.mint({ kind: 'plugin', pluginId: id });
    const file = this.keyFile(id);
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, key + '\n', { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  }

  private revokeKey(id: string): void {
    if (this.keys) { const h = this.keys.liveHandleForPlugin(id); if (h) this.keys.revoke(h); }
    const file = this.keyFile(id);
    if (file) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
  }

  private keyed(id: string): boolean { return this.keys?.liveHandleForPlugin(id) !== undefined; }

  /** Mint a key for every enabled, loadable plugin (boot), and drop keys of plugins that no longer qualify. */
  issueKeys(): void {
    const rows = this.list();
    for (const row of rows) this.syncKey(row);
    // A key file of a folder deleted while the daemon was down is litter: sweep it.
    if (this.keyDir) {
      const ids = new Set(rows.map((r) => r.id));
      let names: string[] = [];
      try { names = fs.readdirSync(this.keyDir); } catch { return; }
      for (const n of names) {
        const id = n.startsWith('plugin-') ? n.slice('plugin-'.length) : null;
        if (id && !ids.has(id)) { try { fs.unlinkSync(path.join(this.keyDir, n)); } catch { /* ignore */ } }
      }
    }
  }

  /** Issue or revoke one plugin's key to match its state (enabled and loadable → keyed). */
  private syncKey(row: PluginRow | undefined, id?: string): void {
    if (!row) { if (id) this.revokeKey(id); return; }
    if (row.enabled && !row.error) { if (!this.keyed(row.id)) this.issueKey(row.id); }
    else this.revokeKey(row.id);
  }

  /**
   * The model part of every enabled, keyed plugin for one harness (spec sections 3.1 and 3.2): MCP
   * server specs (named `plugin-<id>`, with the plugin's identity and key file in their env) and
   * instruction blocks, in id order. A relative arg or command that names a file in the plugin
   * folder becomes absolute, so the server runs from any cwd.
   */
  modelInjection(harness: string): { specs: McpServerSpec[]; prompts: string[]; toolNames: string[] } {
    const specs: McpServerSpec[] = []; const prompts: string[] = []; const toolNames: string[] = [];
    for (const row of this.list()) {
      const model = row.model;
      if (!model || !row.enabled || row.error || !this.keyed(row.id)) continue;
      if (model.harnesses && !model.harnesses.includes(harness)) continue;
      const where = this.folderOf(row.id);
      let folder: string;
      try { folder = fs.realpathSync(where ? where.folder : path.join(this.dir, row.id)); } catch { continue; }
      const abs = (a: string): string => (!path.isAbsolute(a) && this.resolveInside(folder, a) ? path.join(folder, a) : a);
      if (model.mcp) {
        const keyFile = this.keyFile(row.id);
        specs.push({
          name: `plugin-${row.id}`, command: abs(model.mcp.command), args: (model.mcp.args ?? []).map(abs),
          env: { ...(model.mcp.env ?? {}), DISPATCH_PLUGIN: row.id, ...(keyFile ? { DISPATCH_PLUGIN_AUTH_FILE: keyFile } : {}) },
          authEnv: true,
        });
        toolNames.push(`plugin-${row.id}`);
      }
      if (model.instructions) {
        try {
          const text = fs.readFileSync(path.join(folder, model.instructions), 'utf8').trim();
          if (text) prompts.push(`## Plugin: ${row.name}\n\n${text}`);
        } catch { /* listed as broken on the next read */ }
      }
    }
    return { specs, prompts, toolNames };
  }

  /** What a rule knows about a plugin key's plugin: null when unknown, disabled or broken (its key is then refused). */
  facts(id: string): PluginFacts | null {
    const row = this.get(id);
    if (!row || !row.enabled || row.error) return null;
    return { id, permissions: row.permissions ?? [] };
  }

  private get stateFile(): string { return path.join(path.dirname(this.dir), 'plugins.json'); }

  private readState(): StateFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<StateFile>;
      return { disabled: Array.isArray(raw.disabled) ? raw.disabled.filter((x): x is string => typeof x === 'string') : [] };
    } catch { return { disabled: [] }; }
  }

  private writeState(state: StateFile): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  }

  /** Every plugin folder, sorted by id; a broken one carries `error`. */
  list(): PluginRow[] {
    const names = new Set<string>();
    for (const root of [this.dir, this.bundledDir]) {
      if (!root) continue;
      try { for (const n of fs.readdirSync(root)) if (PLUGIN_ID_RE.test(n)) names.add(n); } catch { /* no such folder */ }
    }
    const disabled = new Set(this.readState().disabled);
    const out: PluginRow[] = [];
    for (const id of [...names].sort()) {
      const row = this.read(id, disabled);
      if (row) out.push(row);
    }
    return out;
  }

  get(id: string): PluginRow | undefined {
    if (!PLUGIN_ID_RE.test(id)) return undefined;
    return this.read(id, new Set(this.readState().disabled));
  }

  private read(id: string, disabled: Set<string>): PluginRow | undefined {
    const where = this.folderOf(id);
    if (!where) return undefined;
    const folder = where.folder;
    const place = { ...(where.bundled ? { bundled: true } : {}), ...(where.shadows ? { shadowsBundled: true } : {}) };
    let folderStat: fs.Stats;
    try { folderStat = fs.statSync(folder); } catch { return undefined; }
    const manifestFile = path.join(folder, 'plugin.json');
    let raw: string;
    try { raw = fs.readFileSync(manifestFile, 'utf8'); } catch { return this.broken(id, folderStat.mtimeMs, 'no plugin.json in the folder'); }
    const parsed = parseManifest(raw, id);
    const mtime = (p: string): number => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
    if (!parsed.ok) return this.broken(id, Math.max(folderStat.mtimeMs, mtime(manifestFile)), parsed.error);
    const m = parsed.manifest;
    const stamp = Math.round(Math.max(folderStat.mtimeMs, mtime(manifestFile), m.web ? mtime(path.join(folder, m.web)) : 0, newestMtime(folder)));
    if (!satisfiesDispatch(m.dispatch, this.runningVersion)) {
      return this.broken(id, stamp, `needs Dispatch ${m.dispatch}; this is ${this.runningVersion}`);
    }
    if (m.web && !this.resolveInside(folder, m.web)) return this.broken(id, stamp, `plugin.json "web" names a file that does not exist: ${m.web}`);
    if (m.model?.instructions && !this.resolveInside(folder, m.model.instructions)) return this.broken(id, stamp, `plugin.json "model.instructions" names a file that does not exist: ${m.model.instructions}`);
    for (const [event, hook] of Object.entries(m.model?.hooks ?? {})) if (hook && !this.resolveInside(folder, hook.run)) return this.broken(id, stamp, `plugin.json "model.hooks.${event}.run" names a file that does not exist: ${hook.run}`);
    const assist = this.assistTotals?.(id);
    return { ...m, enabled: !disabled.has(id), stamp, install: this.readInstall(folder), keyed: this.keyed(id), ...(this.hookStats && m.model?.hooks ? { hooks: this.hookStats(id) } : {}), ...(assist && assist.calls > 0 ? { assist } : {}), ...place };
  }

  private broken(id: string, stamp: number, error: string): PluginRow {
    const where = this.folderOf(id);
    return { id, name: id, version: '0.0.0', enabled: false, stamp: Math.round(stamp), error, install: where ? this.readInstall(where.folder) : null, keyed: false, ...(where?.bundled ? { bundled: true } : {}) };
  }

  private readInstall(folder: string): PluginInstall | null {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(folder, INSTALL_FILE), 'utf8')) as Partial<PluginInstall>;
      if (typeof raw.marketplace !== 'string' || typeof raw.version !== 'string') return null;
      return { marketplace: raw.marketplace, version: raw.version, sha256: String(raw.sha256 ?? ''), installedAt: String(raw.installedAt ?? '') };
    } catch { return null; }
  }

  setEnabled(id: string, enabled: boolean): PluginRow {
    const row = this.get(id);
    if (!row) throw new Error('unknown plugin');
    const state = this.readState();
    const set = new Set(state.disabled);
    if (enabled) set.delete(id); else set.add(id);
    this.writeState({ disabled: [...set].sort() });
    if (enabled && !row.error) this.issueKey(id); else this.revokeKey(id);
    return this.get(id)!;
  }

  /** The plugin's real folder (local, else bundled), for processes that run inside it. */
  folderPath(id: string): string | null { const w = this.folderOf(id); try { return w ? fs.realpathSync(w.folder) : null; } catch { return null; } }

  /** The real path of a regular file inside the plugin's real folder, or null when it escapes, is missing, or the plugin is unknown or disabled. */
  resolveFile(id: string, requested: string): string | null {
    const row = this.get(id);
    if (!row || !row.enabled) return null;
    const where = this.folderOf(id);
    return where ? this.resolveInside(where.folder, requested) : null;
  }

  private resolveInside(folder: string, requested: string): string | null {
    if (!requested || path.isAbsolute(requested)) return null;
    let root: string;
    try { root = fs.realpathSync(folder); } catch { return null; }
    let real: string;
    try { real = fs.realpathSync(path.resolve(root, requested)); } catch { return null; }
    const rel = path.relative(root, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    try { if (!fs.statSync(real).isFile()) return null; } catch { return null; }
    return real;
  }

  /** Write a starter plugin from the template. Throws 'bad id' | 'exists'. */
  scaffold(id: string, name: string): PluginRow {
    if (!PLUGIN_ID_RE.test(id)) throw new Error('bad id');
    const folder = path.join(this.dir, id);
    if (fs.existsSync(folder)) throw new Error('exists');
    fs.mkdirSync(folder, { recursive: true });
    for (const [file, body] of Object.entries(pluginTemplate(id, name))) fs.writeFileSync(path.join(folder, file), body);
    this.syncKey(this.get(id), id);
    return this.get(id)!;
  }

  /** Delete a local plugin's folder (a symlinked folder: only the link). Throws 'unknown plugin' | 'not local' | 'bundled'. */
  remove(id: string): void {
    const row = this.get(id);
    if (!row) throw new Error('unknown plugin');
    if (row.bundled) throw new Error('bundled');
    if (row.install) throw new Error('not local');
    this.revokeKey(id);
    const folder = path.join(this.dir, id);
    if (fs.lstatSync(folder).isSymbolicLink()) fs.unlinkSync(folder);
    else fs.rmSync(folder, { recursive: true, force: true });
    const state = this.readState();
    if (state.disabled.includes(id)) this.writeState({ disabled: state.disabled.filter((x) => x !== id) });
  }

  /** Copy a plugin (bundled or local) to a new local folder under a new id (spec section 10). Throws 'unknown plugin' | 'bad id' | 'exists'. */
  copyToLocal(id: string, newId: string): PluginRow {
    const where = this.folderOf(id);
    if (!where) throw new Error('unknown plugin');
    if (!PLUGIN_ID_RE.test(newId)) throw new Error('bad id');
    const target = path.join(this.dir, newId);
    if (this.folderOf(newId)) throw new Error('exists');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.cpSync(fs.realpathSync(where.folder), target, { recursive: true, dereference: true, filter: (src) => !src.includes(`${path.sep}node_modules${path.sep}`) && path.basename(src) !== INSTALL_FILE });
    try {
      const file = path.join(target, 'plugin.json');
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(file, JSON.stringify({ ...raw, id: newId }, null, 2) + '\n');
    } catch { /* the copy lists as broken with the reason */ }
    this.syncKey(this.get(newId), newId);
    return this.get(newId)!;
  }

  /** Send any plugin event to every client (the routes use it for storage changes). */
  broadcast(event: Record<string, unknown>): void { this.broadcaster.broadcast(event); }

  /** Tell every client the plugin changed (or went away): `plugin:changed { id, plugin }`. */
  announce(id: string): void {
    const row = this.get(id);
    // A folder that appeared, was fixed, or went away: its key follows (spec section 6).
    this.syncKey(row, id);
    this.broadcaster.broadcast({ type: 'plugin:changed', id, plugin: row ? this.get(id) ?? null : null });
  }

  /** Watch the folder; a burst of writes to one plugin becomes one announcement. */
  start(): void {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* read-only home: nothing to watch */ }
    try {
      this.watcher = fs.watch(this.dir, { recursive: true }, (_event, filename) => {
        const id = typeof filename === 'string' ? filename.split(path.sep)[0] : null;
        if (!id || !PLUGIN_ID_RE.test(id)) return;
        // An entry added or removed at the top level may be a link: keep the link watchers current.
        if (typeof filename === 'string' && !filename.includes(path.sep)) this.watchLinks();
        this.schedule(id);
      });
      (this.watcher as unknown as NodeJS.EventEmitter).on('error', (e: Error) => console.warn(`[plugins] watcher error: ${e.message}`));
      for (const row of this.list()) this.known.add(row.id);
      this.watchLinks();
    } catch (e) {
      console.warn(`[plugins] could not watch ${this.dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Ids seen as folders, so a removal still announces while the folder's own-name event (FSEvents reports the watched dir as "plugins") does not. */
  private known = new Set<string>();

  private schedule(id: string): void {
    let exists = false;
    try { exists = fs.statSync(path.join(this.dir, id)).isDirectory(); } catch { /* gone or never there */ }
    if (exists) this.known.add(id);
    else if (this.known.has(id)) this.known.delete(id);
    else return;
    const pending = this.timers.get(id);
    if (pending) clearTimeout(pending);
    this.timers.set(id, setTimeout(() => { this.timers.delete(id); this.announce(id); }, DEBOUNCE_MS));
  }

  /** A watcher on the real folder of every symlinked plugin, so an edit to the target announces it too. */
  private watchLinks(): void {
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir).filter((n) => PLUGIN_ID_RE.test(n)); } catch { return; }
    const linked = new Map<string, string>();
    for (const id of names) {
      try {
        const full = path.join(this.dir, id);
        if (fs.lstatSync(full).isSymbolicLink()) linked.set(id, fs.realpathSync(full));
      } catch { /* a broken link: nothing to watch */ }
    }
    for (const [id, w] of this.linkWatchers) if (!linked.has(id)) { w.close(); this.linkWatchers.delete(id); }
    for (const [id, real] of linked) {
      if (this.linkWatchers.has(id)) continue;
      try {
        const w = fs.watch(real, { recursive: true }, () => this.schedule(id));
        (w as unknown as NodeJS.EventEmitter).on('error', () => { w.close(); this.linkWatchers.delete(id); });
        this.linkWatchers.set(id, w);
      } catch { /* the target vanished: the next top-level change retries */ }
    }
  }

  stop(): void {
    this.watcher?.close(); this.watcher = null;
    for (const w of this.linkWatchers.values()) w.close();
    this.linkWatchers.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
