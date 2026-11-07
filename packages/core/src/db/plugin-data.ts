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

/** The assist meter (spec section 3.4). */
export interface AssistTotals { calls: number; inputTokens: number; outputTokens: number }
export function recordAssist(db: Database.Database, pluginId: string, usage: { inputTokens: number; outputTokens: number }, ms: number): void {
  db.prepare('INSERT INTO plugin_assist (plugin_id, at, input_tokens, output_tokens, ms) VALUES (?, ?, ?, ?, ?)').run(pluginId, new Date().toISOString(), usage.inputTokens, usage.outputTokens, ms);
}
export function assistTotals(db: Database.Database, pluginId: string): AssistTotals {
  const r = db.prepare('SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o FROM plugin_assist WHERE plugin_id = ?').get(pluginId) as { calls: number; i: number; o: number };
  return { calls: r.calls, inputTokens: r.i, outputTokens: r.o };
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
