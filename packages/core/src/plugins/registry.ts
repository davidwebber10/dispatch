import fs from 'node:fs';
import path from 'node:path';
import type { EventBroadcaster } from '../ws/events.js';
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
}

const DEBOUNCE_MS = 150;
const INSTALL_FILE = '.dispatch-install.json';

interface StateFile { disabled: string[] }

export class PluginRegistry {
  private watcher: fs.FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(readonly dir: string, private readonly broadcaster: EventBroadcaster, private readonly runningVersion: string) {}

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
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    const disabled = new Set(this.readState().disabled);
    const out: PluginRow[] = [];
    for (const id of names.filter((n) => PLUGIN_ID_RE.test(n)).sort()) {
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
    const folder = path.join(this.dir, id);
    let folderStat: fs.Stats;
    try { folderStat = fs.statSync(folder); } catch { return undefined; }
    if (!folderStat.isDirectory()) return undefined;
    const manifestFile = path.join(folder, 'plugin.json');
    let raw: string;
    try { raw = fs.readFileSync(manifestFile, 'utf8'); } catch { return this.broken(id, folderStat.mtimeMs, 'no plugin.json in the folder'); }
    const parsed = parseManifest(raw, id);
    const mtime = (p: string): number => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
    if (!parsed.ok) return this.broken(id, Math.max(folderStat.mtimeMs, mtime(manifestFile)), parsed.error);
    const m = parsed.manifest;
    const stamp = Math.round(Math.max(folderStat.mtimeMs, mtime(manifestFile), m.web ? mtime(path.join(folder, m.web)) : 0));
    if (!satisfiesDispatch(m.dispatch, this.runningVersion)) {
      return this.broken(id, stamp, `needs Dispatch ${m.dispatch}; this is ${this.runningVersion}`);
    }
    if (m.web && !this.resolveInside(folder, m.web)) return this.broken(id, stamp, `plugin.json "web" names a file that does not exist: ${m.web}`);
    return { ...m, enabled: !disabled.has(id), stamp, install: this.readInstall(folder) };
  }

  private broken(id: string, stamp: number, error: string): PluginRow {
    return { id, name: id, version: '0.0.0', enabled: false, stamp: Math.round(stamp), error, install: this.readInstall(path.join(this.dir, id)) };
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
    return this.get(id)!;
  }

  /** The real path of a regular file inside the plugin's real folder, or null when it escapes, is missing, or the plugin is unknown or disabled. */
  resolveFile(id: string, requested: string): string | null {
    const row = this.get(id);
    if (!row || !row.enabled) return null;
    return this.resolveInside(path.join(this.dir, id), requested);
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
    return this.get(id)!;
  }

  /** Delete a local plugin's folder (a symlinked folder: only the link). Throws 'unknown plugin' | 'not local'. */
  remove(id: string): void {
    const row = this.get(id);
    if (!row) throw new Error('unknown plugin');
    if (row.install) throw new Error('not local');
    const folder = path.join(this.dir, id);
    if (fs.lstatSync(folder).isSymbolicLink()) fs.unlinkSync(folder);
    else fs.rmSync(folder, { recursive: true, force: true });
    const state = this.readState();
    if (state.disabled.includes(id)) this.writeState({ disabled: state.disabled.filter((x) => x !== id) });
  }

  /** Tell every client the plugin changed (or went away): `plugin:changed { id, plugin }`. */
  announce(id: string): void {
    this.broadcaster.broadcast({ type: 'plugin:changed', id, plugin: this.get(id) ?? null });
  }

  /** Watch the folder; a burst of writes to one plugin becomes one announcement. */
  start(): void {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* read-only home: nothing to watch */ }
    try {
      this.watcher = fs.watch(this.dir, { recursive: true }, (_event, filename) => {
        const id = typeof filename === 'string' ? filename.split(path.sep)[0] : null;
        if (!id || !PLUGIN_ID_RE.test(id)) return;
        const pending = this.timers.get(id);
        if (pending) clearTimeout(pending);
        this.timers.set(id, setTimeout(() => { this.timers.delete(id); this.announce(id); }, DEBOUNCE_MS));
      });
      (this.watcher as unknown as NodeJS.EventEmitter).on('error', (e: Error) => console.warn(`[plugins] watcher error: ${e.message}`));
    } catch (e) {
      console.warn(`[plugins] could not watch ${this.dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  stop(): void {
    this.watcher?.close(); this.watcher = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
