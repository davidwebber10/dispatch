import type Database from 'better-sqlite3';
import * as pluginData from '../db/plugin-data.js';

/**
 * Previews moved into the bundled Previews plugin (plugins slice 4). An install that had the
 * previews table copies every row into the plugin's storage once: a `preview:<id>` document
 * and a checked file reference per file. The old table stays until a later release drops it.
 * Returns the number of rows copied.
 */
interface OldRow { id: string; session_id: string; session_name: string | null; terminal_id: string | null; terminal_label: string | null; title: string; note: string | null; text: string | null; files: string; created_at: string; seen_at: string | null }
const PLUGIN = 'previews';

export function migratePreviews(db: Database.Database): number {
  const settings = (pluginData.getSettings(db, PLUGIN)?.value ?? {}) as Record<string, unknown>;
  if (settings.migrated === true) return 0;
  let rows: OldRow[] = [];
  try { rows = db.prepare('SELECT * FROM previews ORDER BY created_at').all() as OldRow[]; } catch { rows = []; }
  let n = 0;
  const copy = db.transaction(() => {
    for (const r of rows) {
      let files: { path: string; name: string; mime: string; size: number }[] = [];
      try { const v = JSON.parse(r.files); files = Array.isArray(v) ? v : []; } catch { files = []; }
      const refs = files.filter((f) => f && typeof f.path === 'string').map((f) => {
        const ref = pluginData.addFile(db, PLUGIN, r.session_id, { path: f.path, name: f.name, mime: f.mime, size: f.size });
        return { fileId: ref.fileId, name: f.name, mime: f.mime, size: f.size };
      });
      const doc = { id: r.id, sessionId: r.session_id, sessionName: r.session_name, terminalId: r.terminal_id, terminalLabel: r.terminal_label, title: r.title, note: r.note, text: r.text, files: refs, createdAt: r.created_at, seenAt: r.seen_at };
      try { pluginData.setDoc(db, PLUGIN, `preview:${r.id}`, doc, null); n++; } catch { /* over the document cap: the newest rows are the ones that fit */ }
    }
    pluginData.setSettings(db, PLUGIN, { ...settings, migrated: true });
  });
  copy();
  return n;
}
