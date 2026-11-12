// packages/core/src/journal/db.ts
//
// The SQL of the message journal (table `thread_journal`, migration `w3d-thread-journal`).
// MessageJournal (journal.ts) is the only caller.

import type Database from 'better-sqlite3';

export type JournalKind = 'user' | 'assistant' | 'tool' | 'result' | 'notice';

export interface JournalRow {
  terminal_id: string;
  seq: number;
  kind: JournalKind;
  native_id: string | null;
  payload: string;
  idem_key: string | null;
  at: string;
  bytes: number;
}

/** The native ids of the gap marks start with this (see MessageJournal.markGap). */
export const GAP_PREFIX = 'gap:';
/** The first string after every string that starts with GAP_PREFIX (';' follows ':'). */
const GAP_END = 'gap;';

export interface JournalStatements {
  insert: Database.Statement;
  updateNative: Database.Statement;
  byNative: Database.Statement;
  byKey: Database.Statement;
  setKey: Database.Statement;
  setNative: Database.Statement;
  lastSeq: Database.Statement;
  firstSeqAbove: Database.Statement;
  floor: Database.Statement;
  newest: Database.Statement;
  before: Database.Statement;
  after: Database.Statement;
  countBelow: Database.Statement;
  stats: Database.Statement;
  oldest: Database.Statement;
  deleteUpTo: Database.Statement;
  deleteThread: Database.Statement;
  totals: Database.Statement;
  anonymous: Database.Statement;
  hasImport: Database.Statement;
  markImport: Database.Statement;
  deleteImports: Database.Statement;
  putImage: Database.Statement;
  getImage: Database.Statement;
  imageStats: Database.Statement;
  oldestImages: Database.Statement;
  deleteImage: Database.Statement;
  deleteImagesUpTo: Database.Statement;
  deleteImages: Database.Statement;
  agentNewest: Database.Statement;
  agentBefore: Database.Statement;
  agentAfter: Database.Statement;
  agentFrames: Database.Statement;
}

/**
 * The rows of one subagent (subagents-v1): its frames (`parent_tool_use_id` = its id) and its
 * lifecycle frames (`system/subagent` with `id` = its id). A payload that is not valid JSON (none
 * should be) never matches.
 */
const AGENT_ROW = `CASE WHEN json_valid(payload) THEN (json_extract(payload, '$.parent_tool_use_id') = @agent
  OR (json_extract(payload, '$.subtype') = 'subagent' AND json_extract(payload, '$.type') = 'system' AND json_extract(payload, '$.id') = @agent)) ELSE 0 END`;

export function prepareJournal(db: Database.Database): JournalStatements {
  return {
    // The next sequence is read and written in one statement: no other writer can take the same one.
    insert: db.prepare(`
      INSERT INTO thread_journal (terminal_id, seq, kind, native_id, payload, idem_key, at, bytes)
      VALUES (@terminal_id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM thread_journal WHERE terminal_id = @terminal_id),
              @kind, @native_id, @payload, @idem_key, @at, @bytes)
      RETURNING seq`),
    updateNative: db.prepare('UPDATE thread_journal SET kind = @kind, payload = @payload, bytes = @bytes WHERE terminal_id = @terminal_id AND seq = @seq'),
    byNative: db.prepare('SELECT seq, bytes FROM thread_journal WHERE terminal_id = ? AND native_id = ?'),
    byKey: db.prepare('SELECT * FROM thread_journal WHERE terminal_id = ? AND idem_key = ?'),
    setKey: db.prepare('UPDATE thread_journal SET idem_key = ? WHERE terminal_id = ? AND seq = ? AND idem_key IS NULL'),
    setNative: db.prepare('UPDATE thread_journal SET native_id = ?, payload = ?, bytes = ? WHERE terminal_id = ? AND seq = ? AND native_id IS NULL'),
    lastSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM thread_journal WHERE terminal_id = ?'),
    firstSeqAbove: db.prepare('SELECT COALESCE(MIN(seq), 0) AS seq FROM thread_journal WHERE terminal_id = ? AND seq > ?'),
    floor: db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM thread_journal WHERE terminal_id = ? AND native_id >= '${GAP_PREFIX}' AND native_id < '${GAP_END}'`),
    newest: db.prepare('SELECT * FROM thread_journal WHERE terminal_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?'),
    before: db.prepare('SELECT * FROM thread_journal WHERE terminal_id = ? AND seq > ? AND seq < ? ORDER BY seq DESC LIMIT ?'),
    after: db.prepare('SELECT * FROM thread_journal WHERE terminal_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'),
    countBelow: db.prepare('SELECT COUNT(*) AS n FROM thread_journal WHERE terminal_id = ? AND seq > ? AND seq < ?'),
    stats: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM thread_journal WHERE terminal_id = ?'),
    oldest: db.prepare('SELECT seq, bytes FROM thread_journal WHERE terminal_id = ? ORDER BY seq ASC LIMIT ?'),
    deleteUpTo: db.prepare('DELETE FROM thread_journal WHERE terminal_id = ? AND seq <= ?'),
    deleteThread: db.prepare('DELETE FROM thread_journal WHERE terminal_id = ?'),
    totals: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes, COUNT(DISTINCT terminal_id) AS threads FROM thread_journal'),
    // The user and assistant rows with no native id, oldest first (the dedupe of an import: see recorder.ts).
    anonymous: db.prepare("SELECT seq, payload FROM thread_journal WHERE terminal_id = ? AND native_id IS NULL AND kind IN ('user', 'assistant') ORDER BY seq ASC"),
    hasImport: db.prepare('SELECT 1 AS n FROM thread_journal_imports WHERE terminal_id = ? AND session_id = ?'),
    markImport: db.prepare('INSERT OR IGNORE INTO thread_journal_imports (terminal_id, session_id, at) VALUES (?, ?, ?)'),
    deleteImports: db.prepare('DELETE FROM thread_journal_imports WHERE terminal_id = ?'),
    // The images of the items over the payload limit (table `thread_journal_images`). The same image again keeps
    // its bytes and moves `last_seq` to the newest row that refers to it.
    putImage: db.prepare(`
      INSERT INTO thread_journal_images (terminal_id, id, media_type, data, bytes, last_seq, at)
      VALUES (@terminal_id, @id, @media_type, @data, @bytes, @last_seq, @at)
      ON CONFLICT (terminal_id, id) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)`),
    getImage: db.prepare('SELECT media_type, data FROM thread_journal_images WHERE terminal_id = ? AND id = ?'),
    imageStats: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM thread_journal_images WHERE terminal_id = ?'),
    oldestImages: db.prepare('SELECT id, bytes, last_seq FROM thread_journal_images WHERE terminal_id = ? ORDER BY last_seq ASC, at ASC'),
    deleteImage: db.prepare('DELETE FROM thread_journal_images WHERE terminal_id = ? AND id = ?'),
    deleteImagesUpTo: db.prepare('DELETE FROM thread_journal_images WHERE terminal_id = ? AND last_seq <= ?'),
    deleteImages: db.prepare('DELETE FROM thread_journal_images WHERE terminal_id = ?'),
    agentNewest: db.prepare(`SELECT * FROM thread_journal WHERE terminal_id = @terminal_id AND seq > @floor AND ${AGENT_ROW} ORDER BY seq DESC LIMIT @limit`),
    agentBefore: db.prepare(`SELECT * FROM thread_journal WHERE terminal_id = @terminal_id AND seq > @floor AND seq < @before AND ${AGENT_ROW} ORDER BY seq DESC LIMIT @limit`),
    agentAfter: db.prepare(`SELECT * FROM thread_journal WHERE terminal_id = @terminal_id AND seq > @floor AND seq > @after AND ${AGENT_ROW} ORDER BY seq ASC LIMIT @limit`),
    // The lifecycle frames of every subagent of a thread, oldest first (the agent list after a restart).
    agentFrames: db.prepare(`SELECT * FROM thread_journal WHERE terminal_id = ? AND kind = 'notice' AND payload LIKE '%"subtype":"subagent"%' ORDER BY seq ASC`),
  };
}
