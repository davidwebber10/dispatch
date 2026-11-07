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

export function listDocs(db: Database.Database, pluginId: string): PluginDocMeta[] {
  const rows = db.prepare('SELECT * FROM plugin_data WHERE plugin_id = ? ORDER BY key').all(pluginId) as Row[];
  return rows.map((r) => ({ key: r.key, writer: parseWriter(r.writer), updatedAt: r.updated_at, bytes: Buffer.byteLength(r.value, 'utf8') }));
}

/** Drop everything a plugin stored (remove, or the owner's "clear data"). */
export function clearPlugin(db: Database.Database, pluginId: string): void {
  db.prepare('DELETE FROM plugin_data WHERE plugin_id = ?').run(pluginId);
  db.prepare('DELETE FROM plugin_settings WHERE plugin_id = ?').run(pluginId);
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
