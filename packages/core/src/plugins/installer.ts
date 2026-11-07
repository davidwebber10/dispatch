import fs from 'node:fs';
import path from 'node:path';
import type { PluginRegistry, PluginRow } from './registry.js';
import type { MarketplaceService, CatalogEntry } from './marketplaces.js';
import { satisfiesDispatch } from './manifest.js';

/**
 * Install, update, roll back, pin, auto-update (docs/superpowers/specs/2026-11-07-plugins-design.md,
 * section 7.2). An installed plugin is a copy of `plugins/<id>` from a marketplace clone under the
 * local plugins folder, with `.dispatch-install.json` naming the marketplace, the version and the
 * commit. An update stages the new folder, swaps it in and keeps the old one as `<id>.prev`; a
 * roll back swaps them again. Pins and the auto-update switches live in `stateFile`.
 */
export interface PluginUpdate { id: string; name: string; marketplace: string; from: string; to: string; changelog: string | null }
export interface InstallInfo { update?: { to: string; changelog: string | null }; pinned?: string; autoUpdate?: boolean; marketplaceGone?: boolean }
interface State { pins: Record<string, string>; autoUpdate: string[] }

export const SUPPORTED_SDK = 1;
const INSTALL_FILE = '.dispatch-install.json';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `1.10.0` sorts after `1.9.1`: numeric per segment, then the text. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/); const pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0'; const y = pb[i] ?? '0';
    const nx = Number(x); const ny = Number(y);
    const c = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y);
    if (c !== 0) return c;
  }
  return 0;
}

export class PluginInstaller {
  private lastUpdates = new Map<string, PluginUpdate>();
  private readonly copy: (from: string, to: string) => void;

  constructor(private readonly registry: PluginRegistry, private readonly markets: MarketplaceService, private readonly pluginsDir: string, private readonly runningVersion: string, private readonly stateFile: string, opts: { copy?: (from: string, to: string) => void } = {}) {
    this.copy = opts.copy ?? ((from, to) => fs.cpSync(from, to, { recursive: true }));
    registry.setInstallInfoProvider((id) => this.info(id));
  }

  /** What the row shows: the update waiting, the pin, the switch, and whether the marketplace is gone. */
  info(id: string): InstallInfo | null {
    // Read the install file here, not through the registry: the registry calls this while it builds the row.
    let url: string | null = null;
    try { const raw = JSON.parse(fs.readFileSync(path.join(this.pluginsDir, id, INSTALL_FILE), 'utf8')) as { marketplace?: unknown }; url = typeof raw.marketplace === 'string' ? raw.marketplace : null; } catch { return null; }
    if (!url) return null;
    const state = this.readState();
    const up = this.lastUpdates.get(id);
    return {
      ...(up ? { update: { to: up.to, changelog: up.changelog } } : {}),
      ...(state.pins[id] ? { pinned: state.pins[id] } : {}),
      autoUpdate: state.autoUpdate.includes(id),
      ...(this.markets.list().some((m) => m.url === url) ? {} : { marketplaceGone: true }),
    };
  }

  async install(slug: string, id: string, version?: string): Promise<PluginRow> {
    if (!ID_RE.test(id)) throw new Error('bad id');
    const m = this.markets.get(slug);
    if (!m) throw new Error('unknown marketplace');
    await this.markets.pull(slug);
    if (this.registry.get(id)) {
      const row = this.registry.get(id)!;
      throw new Error(row.install ? `"${id}" is already installed` : row.bundled ? `"${id}" is a bundled plugin` : `a local plugin "${id}" exists`);
    }
    const entry = (await this.markets.catalog()).find((e) => e.marketplace === slug && e.kind === 'plugin' && e.id === id);
    if (!entry) throw new Error(`"${id}" is not in the marketplace`);
    let commit: string | null = await this.markets.head(slug);
    let target: { version: string; dispatch?: string; sdk?: number } = entry;
    if (version && version !== entry.version) {
      const v = (await this.markets.versions(slug, id)).find((x) => x.version === version);
      if (!v) throw new Error(`"${id}" has no version ${version} in the marketplace`);
      commit = v.commit;
      target = this.manifestAt(await this.markets.folderAt(slug, id, commit)) ?? { version };
    }
    this.check(entry.id, target);
    const exported = await this.markets.folderAt(slug, id, commit ?? 'HEAD');
    fs.mkdirSync(this.pluginsDir, { recursive: true });
    const dest = path.join(this.pluginsDir, id);
    this.copy(exported, dest);
    fs.rmSync(exported, { recursive: true, force: true });
    this.writeInstall(dest, m.url, target.version, commit);
    this.registry.setEnabled(id, true);
    this.registry.announce(id);
    return this.registry.get(id)!;
  }

  /** The updates waiting, from the clones as they are (no pull here): newer than installed and not past a pin. */
  async updates(): Promise<PluginUpdate[]> {
    const catalog = await this.markets.catalog();
    const state = this.readState();
    const out: PluginUpdate[] = [];
    for (const row of this.registry.list()) {
      if (!row.install) continue;
      const m = this.marketOf(row);
      if (!m) continue;
      const entry = catalog.find((e) => e.marketplace === m.slug && e.kind === 'plugin' && e.id === row.id);
      if (!entry || compareVersions(entry.version, row.install.version) <= 0) continue;
      const pin = state.pins[row.id];
      if (pin && compareVersions(entry.version, pin) > 0) continue;
      out.push({ id: row.id, name: entry.name, marketplace: m.slug, from: row.install.version, to: entry.version, changelog: entry.changelog });
    }
    this.lastUpdates = new Map(out.map((u) => [u.id, u]));
    return out;
  }

  /** Pull the marketplace, stage the new folder, swap it in (the old one stays as `.prev`), announce. */
  async update(id: string): Promise<PluginRow> {
    const row = this.registry.get(id);
    if (!row?.install) throw new Error('not an installed plugin');
    const m = this.marketOf(row);
    if (!m) throw new Error('the marketplace of this plugin is gone');
    await this.markets.pull(m.slug);
    const entry = (await this.markets.catalog()).find((e) => e.marketplace === m.slug && e.kind === 'plugin' && e.id === id);
    if (!entry) throw new Error(`"${id}" is no longer in the marketplace`);
    this.check(id, entry);
    const commit = await this.markets.head(m.slug);
    const exported = await this.markets.folderAt(m.slug, id, commit ?? 'HEAD');
    const dest = path.join(this.pluginsDir, id);
    const staging = path.join(this.pluginsDir, `${id}.staging`);
    const prev = path.join(this.pluginsDir, `${id}.prev`);
    fs.rmSync(staging, { recursive: true, force: true });
    try {
      this.copy(exported, staging);
      this.writeInstall(staging, m.url, entry.version, commit);
    } catch (e) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw e;
    } finally { fs.rmSync(exported, { recursive: true, force: true }); }
    fs.rmSync(prev, { recursive: true, force: true });
    fs.renameSync(dest, prev);
    fs.renameSync(staging, dest);
    const from = row.install.version;
    this.lastUpdates.delete(id);
    this.registry.announce(id);
    this.registry.broadcast({ type: 'plugin:updated', id, from, to: entry.version });
    return this.registry.get(id)!;
  }

  /** Swap `.prev` back; the replaced folder becomes the new `.prev`, so a second roll back goes forward. */
  async rollback(id: string): Promise<PluginRow> {
    const row = this.registry.get(id);
    if (!row?.install) throw new Error('not an installed plugin');
    const dest = path.join(this.pluginsDir, id);
    const prev = path.join(this.pluginsDir, `${id}.prev`);
    if (!fs.existsSync(prev)) throw new Error('nothing to roll back to');
    const tmp = path.join(this.pluginsDir, `${id}.swap`);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.renameSync(dest, tmp);
    fs.renameSync(prev, dest);
    fs.renameSync(tmp, prev);
    const from = row.install.version;
    this.registry.announce(id);
    const after = this.registry.get(id)!;
    this.registry.broadcast({ type: 'plugin:updated', id, from, to: after.install?.version ?? after.version });
    return after;
  }

  pin(id: string, version: string | null): void {
    const s = this.readState();
    if (version) s.pins[id] = version; else delete s.pins[id];
    this.writeState(s);
    this.registry.announce(id);
  }

  setAutoUpdate(id: string, on: boolean): void {
    const s = this.readState();
    s.autoUpdate = on ? [...new Set([...s.autoUpdate, id])] : s.autoUpdate.filter((x) => x !== id);
    this.writeState(s);
    this.registry.announce(id);
  }

  /** The schedule and "Check now": pull every marketplace, apply the auto-updates, tell the clients what waits. */
  async checkNow(): Promise<{ updated: string[]; updates: PluginUpdate[] }> {
    await this.markets.pullAll();
    const updated: string[] = [];
    const state = this.readState();
    for (const u of await this.updates()) {
      const trusted = this.markets.get(u.marketplace)?.trusted === true;
      if (!state.autoUpdate.includes(u.id) && !trusted) continue;
      try { await this.update(u.id); updated.push(u.id); } catch { /* the row keeps "update available"; the owner sees why on Update */ }
    }
    const updates = await this.updates();
    this.registry.broadcast({ type: 'plugin:updates', updates });
    return { updated, updates };
  }

  private check(id: string, target: { dispatch?: string; sdk?: number }): void {
    if (!satisfiesDispatch(target.dispatch, this.runningVersion)) throw new Error(`"${id}" needs Dispatch ${target.dispatch}; this is ${this.runningVersion}`);
    if (typeof target.sdk === 'number' && target.sdk > SUPPORTED_SDK) throw new Error(`"${id}" needs SDK ${target.sdk}; this Dispatch has SDK ${SUPPORTED_SDK}`);
  }
  private manifestAt(folder: string): { version: string; dispatch?: string; sdk?: number } | null {
    try { const v = JSON.parse(fs.readFileSync(path.join(folder, 'plugin.json'), 'utf8')) as Record<string, unknown>; return typeof v.version === 'string' ? { version: v.version, ...(typeof v.dispatch === 'string' ? { dispatch: v.dispatch } : {}), ...(typeof v.sdk === 'number' ? { sdk: v.sdk } : {}) } : null; } catch { return null; }
  }
  private marketOf(row: PluginRow) { return row.install ? this.markets.list().find((m) => m.url === row.install!.marketplace) ?? null : null; }
  private writeInstall(folder: string, url: string, version: string, commit: string | null): void {
    fs.writeFileSync(path.join(folder, INSTALL_FILE), JSON.stringify({ marketplace: url, version, commit: commit ?? '', installedAt: new Date().toISOString() }, null, 2) + '\n');
  }
  private readState(): State {
    try { const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<State>; return { pins: raw.pins && typeof raw.pins === 'object' ? raw.pins as Record<string, string> : {}, autoUpdate: Array.isArray(raw.autoUpdate) ? raw.autoUpdate.filter((x): x is string => typeof x === 'string') : [] }; } catch { return { pins: {}, autoUpdate: [] }; }
  }
  private writeState(s: State): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  }
}

export type { CatalogEntry };
