import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * Plugin storage (docs/superpowers/specs/2026-11-07-plugins-design.md, section 5): JSON documents
 * per plugin, and one settings document per plugin. A thread's write carries the writer the
 * daemon stamped from its key.
 */
export const DOC_MAX_BYTES = 262144;
export const DOCS_MAX = 2000;
const KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export interface Writer { terminalId: string; sessionId: string; label: string | null }
export interface PluginDoc { key: string; value: unknown; writer: Writer | null; updatedAt: string; bytes: number }
export interface PluginDocMeta { key: string; writer: Writer | null; updatedAt: string; bytes: number }

interface Row { plugin_id: string; key: string; value: string; writer: string | null; updated_at: string }

const parseWriter = (raw: string | null): Writer | null => { if (!raw) return null; try { return JSON.parse(raw) as Writer; } catch { return null; } };
const parseValue = (raw: string): unknown => { try { return JSON.parse(raw); } catch { return null; } };
const serialize = (value: unknown): string => {
  const text = JSON.stringify(value === undefined ? null : value);
  if (Buffer.byteLength(text, 'utf8') > DOC_MAX_BYTES) throw new Error('too large');
  return text;
};
const toDoc = (r: Row): PluginDoc => ({ key: r.key, value: parseValue(r.value), writer: parseWriter(r.writer), updatedAt: r.updated_at, bytes: Buffer.byteLength(r.value, 'utf8') });

function checkKey(key: string): void {
  if (typeof key !== 'string' || !KEY_RE.test(key) || key.includes('..')) throw new Error('bad key');
}

export function getDoc(db: Database.Database, pluginId: string, key: string): PluginDoc | null {
  const r = db.prepare('SELECT * FROM plugin_data WHERE plugin_id = ? AND key = ?').get(pluginId, key) as Row | undefined;
  return r ? toDoc(r) : null;
}

/** Throws 'bad key' | 'too large' | 'too many'. */
export function setDoc(db: Database.Database, pluginId: string, key: string, value: unknown, writer: Writer | null): PluginDoc {
  checkKey(key);
  const text = serialize(value);
  const exists = db.prepare('SELECT 1 FROM plugin_data WHERE plugin_id = ? AND key = ?').get(pluginId, key);
  if (!exists) {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM plugin_data WHERE plugin_id = ?').get(pluginId) as { n: number }).n;
    if (n >= DOCS_MAX) throw new Error('too many');
  }
  const updatedAt = new Date().toISOString();
  db.prepare(`INSERT INTO plugin_data (plugin_id, key, value, writer, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value, writer = excluded.writer, updated_at = excluded.updated_at`)
    .run(pluginId, key, text, writer ? JSON.stringify(writer) : null, updatedAt);
  return getDoc(db, pluginId, key)!;
}

export function deleteDoc(db: Database.Database, pluginId: string, key: string): boolean {
  return db.prepare('DELETE FROM plugin_data WHERE plugin_id = ? AND key = ?').run(pluginId, key).changes > 0;
}

export function listDocs(db: Database.Database, pluginId: string): PluginDocMeta[];
export function listDocs(db: Database.Database, pluginId: string, opts: { values: true }): PluginDoc[];
/** The documents of a plugin, by key; with `values` each carries its value (one call for a store). */
export function listDocs(db: Database.Database, pluginId: string, opts?: { values?: boolean }): PluginDocMeta[] | PluginDoc[] {
  const rows = db.prepare('SELECT * FROM plugin_data WHERE plugin_id = ? ORDER BY key').all(pluginId) as Row[];
  if (opts?.values) return rows.map(toDoc);
  return rows.map((r) => ({ key: r.key, writer: parseWriter(r.writer), updatedAt: r.updated_at, bytes: Buffer.byteLength(r.value, 'utf8') }));
}

/** Drop everything a plugin stored (remove, or the owner's "clear data"). */
export function clearPlugin(db: Database.Database, pluginId: string): void {
  db.prepare('DELETE FROM plugin_data WHERE plugin_id = ?').run(pluginId);
  db.prepare('DELETE FROM plugin_settings WHERE plugin_id = ?').run(pluginId);
  db.prepare('DELETE FROM plugin_files WHERE plugin_id = ?').run(pluginId);
  db.prepare('DELETE FROM plugin_budget WHERE plugin_id = ?').run(pluginId);
}

export function getSettings(db: Database.Database, pluginId: string): { value: unknown; updatedAt: string } | null {
  const r = db.prepare('SELECT value, updated_at FROM plugin_settings WHERE plugin_id = ?').get(pluginId) as { value: string; updated_at: string } | undefined;
  return r ? { value: parseValue(r.value), updatedAt: r.updated_at } : null;
}

/** Throws 'too large'. */
export function setSettings(db: Database.Database, pluginId: string, value: unknown): { value: unknown; updatedAt: string } {
  const text = serialize(value);
  const updatedAt = new Date().toISOString();
  db.prepare(`INSERT INTO plugin_settings (plugin_id, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(plugin_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(pluginId, text, updatedAt);
  return getSettings(db, pluginId)!;
}

/**
 * The assist meter (plugins spec section 3.4; coach spec section 7.2): one row per call, failed
 * calls included (`ok` false). `inputTokens` is the uncached input; the cache tokens are apart.
 * `costUsd` is what the harness reported or what the route priced; null = not known.
 */
export interface AssistRecord {
  at?: string;
  model: string;
  harness: string;
  accountId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number | null;
  /** True when the daemon estimated `costUsd` (no reported cost, no known price). */
  costEstimated?: boolean;
  ms: number;
  ok: boolean;
}
export function recordAssist(db: Database.Database, pluginId: string, r: AssistRecord): void {
  db.prepare(`INSERT INTO plugin_assist (plugin_id, at, model, harness, account_id, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, cost_usd, cost_estimated, ms, ok)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(pluginId, r.at ?? new Date().toISOString(), r.model, r.harness, r.accountId, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheCreateTokens, r.costUsd, r.costEstimated ? 1 : 0, r.ms, r.ok ? 1 : 0);
}

export interface AssistUsageByModel { model: string; harness: string; calls: number; inputTokens: number; outputTokens: number }
export interface AssistUsage {
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  /** The known costs summed (a call with no known cost adds nothing). */
  costUsd: number;
  byModel: AssistUsageByModel[];
}
/** A plugin's calls with `from <= at < to` (ISO times), summed and by model (most input first). */
export function assistUsage(db: Database.Database, pluginId: string, from: string, to: string): AssistUsage {
  const t = db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o, COALESCE(SUM(cost_usd), 0) AS c
    FROM plugin_assist WHERE plugin_id = ? AND at >= ? AND at < ?`).get(pluginId, from, to) as { calls: number; failed: number; i: number; o: number; c: number };
  const byModel = db.prepare(`SELECT COALESCE(model, '') AS model, COALESCE(harness, '') AS harness, COUNT(*) AS calls,
      COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens
    FROM plugin_assist WHERE plugin_id = ? AND at >= ? AND at < ?
    GROUP BY COALESCE(model, ''), COALESCE(harness, '') ORDER BY inputTokens DESC, model`).all(pluginId, from, to) as AssistUsageByModel[];
  return { calls: t.calls, failed: t.failed, inputTokens: t.i, outputTokens: t.o, costUsd: t.c, byModel };
}

/** The known cost of a plugin's calls on one harness since `from` (the OpenRouter dollar budget). */
export function assistCostSince(db: Database.Database, pluginId: string, harness: string, from: string): number {
  const r = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM plugin_assist WHERE plugin_id = ? AND harness = ? AND at >= ?').get(pluginId, harness, from) as { c: number };
  return r.c;
}

/**
 * A plugin's subscription tokens since `from` (every harness but OpenRouter), for the fail-safe
 * token cap: input, output and cache writes, and a tenth of the cache reads (their price share).
 */
export function assistTokensSince(db: Database.Database, pluginId: string, from: string): number {
  const r = db.prepare(`SELECT COALESCE(SUM(input_tokens + output_tokens + COALESCE(cache_create_tokens, 0) + COALESCE(cache_read_tokens, 0) / 10.0), 0) AS n
    FROM plugin_assist WHERE plugin_id = ? AND COALESCE(harness, '') <> 'openrouter' AND at >= ?`).get(pluginId, from) as { n: number };
  return Math.round(r.n);
}

/**
 * A plugin's model budget (coach spec sections 4.5, 7.4): at most `percentWeekly` % of the weekly
 * limit of the account a call runs on, and at most `usdWeekly` dollars a week on OpenRouter.
 * Null = no cap of that kind.
 */
export interface PluginBudget { percentWeekly: number | null; usdWeekly: number | null }
export function getBudget(db: Database.Database, pluginId: string): PluginBudget {
  const r = db.prepare('SELECT percent_weekly AS p, usd_weekly AS u FROM plugin_budget WHERE plugin_id = ?').get(pluginId) as { p: number | null; u: number | null } | undefined;
  return { percentWeekly: r?.p ?? null, usdWeekly: r?.u ?? null };
}
export function setBudget(db: Database.Database, pluginId: string, budget: PluginBudget): PluginBudget {
  if (budget.percentWeekly === null && budget.usdWeekly === null) {
    db.prepare('DELETE FROM plugin_budget WHERE plugin_id = ?').run(pluginId);
  } else {
    db.prepare(`INSERT INTO plugin_budget (plugin_id, percent_weekly, usd_weekly, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(plugin_id) DO UPDATE SET percent_weekly = excluded.percent_weekly, usd_weekly = excluded.usd_weekly, updated_at = excluded.updated_at`)
      .run(pluginId, budget.percentWeekly, budget.usdWeekly, new Date().toISOString());
  }
  return getBudget(db, pluginId);
}

/** The Plugins page row: the last `days` days (coach spec section 4.5). */
export const ASSIST_ROW_DAYS = 7;
export interface AssistTotals { calls: number; failed: number; inputTokens: number; outputTokens: number; costUsd: number; days: number }
export function assistTotals(db: Database.Database, pluginId: string, now = Date.now()): AssistTotals {
  const u = assistUsage(db, pluginId, new Date(now - ASSIST_ROW_DAYS * 86_400_000).toISOString(), new Date(now + 60_000).toISOString());
  return { calls: u.calls, failed: u.failed, inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUsd, days: ASSIST_ROW_DAYS };
}

/**
 * File references (spec section 5): a checked file of a project a plugin may serve to the owner.
 * The path is re-checked against the project's current folder when the file is served.
 */
export interface PluginFile { fileId: string; sessionId: string; path: string; name: string; mime: string; size: number; createdAt: string }
interface FileRow { file_id: string; session_id: string; path: string; name: string; mime: string; size: number; created_at: string }
const toFile = (r: FileRow): PluginFile => ({ fileId: r.file_id, sessionId: r.session_id, path: r.path, name: r.name, mime: r.mime, size: r.size, createdAt: r.created_at });

export function addFile(db: Database.Database, pluginId: string, sessionId: string, file: { path: string; name: string; mime: string; size: number }): PluginFile {
  const fileId = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare('INSERT INTO plugin_files (plugin_id, file_id, session_id, path, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(pluginId, fileId, sessionId, file.path, file.name, file.mime, file.size, createdAt);
  return { fileId, sessionId, createdAt, ...file };
}

export function getFile(db: Database.Database, pluginId: string, fileId: string): PluginFile | null {
  const r = db.prepare('SELECT * FROM plugin_files WHERE plugin_id = ? AND file_id = ?').get(pluginId, fileId) as FileRow | undefined;
  return r ? toFile(r) : null;
}

export function removeFile(db: Database.Database, pluginId: string, fileId: string): boolean {
  return db.prepare('DELETE FROM plugin_files WHERE plugin_id = ? AND file_id = ?').run(pluginId, fileId).changes > 0;
}

/**
 * Export and import (owner, 2026-11-07): one JSON file with a plugin's documents, settings and
 * file references. A file reference is a path in a project, not the bytes: the bytes stay in the
 * project, and the daemon re-checks the path against the project's folder when it serves it.
 */
export const EXPORT_FORMAT = 'dispatch-plugin-data';
export const EXPORT_VERSION = 1;
export interface PluginExport {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  pluginId: string;
  exportedAt: string;
  settings: unknown;
  docs: Array<{ key: string; value: unknown; updatedAt: string }>;
  files: PluginFile[];
}

/** True when the plugin has any document, settings or file stored. */
export function hasData(db: Database.Database, pluginId: string): boolean {
  return ['plugin_data', 'plugin_settings', 'plugin_files'].some((t) => !!db.prepare(`SELECT 1 FROM ${t} WHERE plugin_id = ? LIMIT 1`).get(pluginId));
}

export function exportPlugin(db: Database.Database, pluginId: string): PluginExport {
  const files = (db.prepare('SELECT * FROM plugin_files WHERE plugin_id = ? ORDER BY created_at, file_id').all(pluginId) as FileRow[]).map(toFile);
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    pluginId,
    exportedAt: new Date().toISOString(),
    settings: getSettings(db, pluginId)?.value ?? null,
    docs: listDocs(db, pluginId, { values: true }).map((d) => ({ key: d.key, value: d.value, updatedAt: d.updatedAt })),
    files,
  };
}

/** A refused import: `status` is the HTTP status (400 for a bad file, 413 over the caps). */
export class ImportError extends Error {
  constructor(public status: 400 | 413, public code: string, message: string) { super(message); }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isoOrNow = (v: unknown): string => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : new Date().toISOString());

/**
 * Write an export file into `pluginId` in one transaction: all of it or nothing.
 * merge: each document, the settings (when not null) and each file overwrite the same key;
 * replace: the plugin's data is cleared first. Throws ImportError.
 */
export function importPlugin(
  db: Database.Database, pluginId: string, data: unknown, opts: { mode: 'merge' | 'replace'; force?: boolean },
): { docs: number; files: number; settings: boolean } {
  if (!isObj(data) || data.format !== EXPORT_FORMAT) throw new ImportError(400, 'bad_format', `This is not a ${EXPORT_FORMAT} file.`);
  if (data.version !== EXPORT_VERSION) throw new ImportError(400, 'bad_version', `This file is version ${String(data.version)}; Dispatch reads version ${EXPORT_VERSION}.`);
  if (!str(data.pluginId)) throw new ImportError(400, 'bad_format', 'The file names no plugin.');
  if (data.pluginId !== pluginId && !opts.force) {
    throw new ImportError(400, 'other_plugin', `This file holds the data of "${data.pluginId}", not "${pluginId}". Add ?force=1 to import it anyway.`);
  }
  const docsIn = data.docs ?? [];
  const filesIn = data.files ?? [];
  if (!Array.isArray(docsIn) || !Array.isArray(filesIn)) throw new ImportError(400, 'bad_format', 'docs and files must be lists.');

  // Check everything before the first write.
  const docs = docsIn.map((d: unknown) => {
    if (!isObj(d) || typeof d.key !== 'string') throw new ImportError(400, 'bad_format', 'Each document needs a key.');
    try { checkKey(d.key); } catch { throw new ImportError(400, 'bad_key', `"${d.key}" is not a valid key.`); }
    let text: string;
    try { text = serialize(d.value); } catch { throw new ImportError(413, 'too_large', `The document "${d.key}" is over ${DOC_MAX_BYTES} bytes.`); }
    return { key: d.key, text, updatedAt: isoOrNow(d.updatedAt) };
  });
  let settings: string | null = null;
  if (data.settings !== undefined && data.settings !== null) {
    try { settings = serialize(data.settings); } catch { throw new ImportError(413, 'too_large', `The settings are over ${DOC_MAX_BYTES} bytes.`); }
  }
  const files = filesIn.map((f: unknown) => {
    if (!isObj(f) || !str(f.fileId) || !str(f.sessionId) || !str(f.path) || !str(f.name) || !str(f.mime)
      || typeof f.size !== 'number' || !Number.isFinite(f.size) || f.size < 0) {
      throw new ImportError(400, 'bad_format', 'Each file needs fileId, sessionId, path, name, mime and size.');
    }
    return { fileId: f.fileId, sessionId: f.sessionId, path: f.path, name: f.name, mime: f.mime, size: f.size, createdAt: isoOrNow(f.createdAt) };
  });

  db.transaction(() => {
    if (opts.mode === 'replace') clearPlugin(db, pluginId);
    const has = db.prepare('SELECT 1 FROM plugin_data WHERE plugin_id = ? AND key = ?');
    const existing = (db.prepare('SELECT COUNT(*) AS n FROM plugin_data WHERE plugin_id = ?').get(pluginId) as { n: number }).n;
    const fresh = new Set(docs.filter((d) => !has.get(pluginId, d.key)).map((d) => d.key)).size;
    if (existing + fresh > DOCS_MAX) {
      throw new ImportError(413, 'too_many', `A plugin holds at most ${DOCS_MAX} documents; this import would make ${existing + fresh}.`);
    }
    const upsertDoc = db.prepare(`INSERT INTO plugin_data (plugin_id, key, value, writer, updated_at) VALUES (?, ?, ?, NULL, ?)
      ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value, writer = NULL, updated_at = excluded.updated_at`);
    for (const d of docs) upsertDoc.run(pluginId, d.key, d.text, d.updatedAt);
    if (settings !== null) {
      db.prepare(`INSERT INTO plugin_settings (plugin_id, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(plugin_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(pluginId, settings, new Date().toISOString());
    }
    // file_id is unique across all plugins: a reference that another plugin holds gets a new id here.
    const holder = db.prepare('SELECT plugin_id FROM plugin_files WHERE file_id = ?');
    const upsertFile = db.prepare(`INSERT INTO plugin_files (plugin_id, file_id, session_id, path, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET session_id = excluded.session_id, path = excluded.path, name = excluded.name, mime = excluded.mime, size = excluded.size, created_at = excluded.created_at`);
    for (const f of files) {
      const held = holder.get(f.fileId) as { plugin_id: string } | undefined;
      const fileId = held && held.plugin_id !== pluginId ? randomUUID() : f.fileId;
      upsertFile.run(pluginId, fileId, f.sessionId, f.path, f.name, f.mime, f.size, f.createdAt);
    }
  })();
  return { docs: docs.length, files: files.length, settings: settings !== null };
}
