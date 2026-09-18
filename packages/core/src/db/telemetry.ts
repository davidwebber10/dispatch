import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type Coverage = 'reported' | 'partial' | 'missing' | 'unsupported';
export interface Tokens { input: number; output: number; cacheRead: number; cacheCreate: number }
export interface Measurement extends Tokens {
  eventId?: string;
  model: string;
  sessionId?: string;
  source: 'structured' | 'pty' | 'runner';
  coverage?: Coverage;
  kind?: 'usage' | 'tool' | 'cost';
  toolCalls?: number;
  reportedCostUsd?: number | null;
  /** Cumulative counters are checkpointed atomically with their derived facts. */
  counter?: { key: string; totals: Tokens; baselineOnly?: boolean; initialIsDelta?: boolean; final?: boolean; unit?: 'tokens' | 'usd' };
}

export function initTelemetrySchema(db: Database.Database): void {
  db.transaction(() => {
    const cols = new Set((db.pragma('table_info(usage_turns)') as { name: string }[]).map((c) => c.name));
    for (const [name, definition] of Object.entries({
      telemetry_version: 'INTEGER NOT NULL DEFAULT 0',
      coverage: "TEXT NOT NULL DEFAULT 'missing'",
      transport: "TEXT NOT NULL DEFAULT 'legacy'",
      external_session_id: "TEXT NOT NULL DEFAULT ''",
      native_turn_id: 'TEXT',
      duration_ms: 'REAL',
      reported_cost_usd: 'REAL',
    })) if (!cols.has(name)) db.exec(`ALTER TABLE usage_turns ADD COLUMN ${name} ${definition}`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_facts (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES usage_turns(id) ON DELETE CASCADE,
        terminal_id TEXT NOT NULL, provider TEXT NOT NULL, external_session_id TEXT NOT NULL,
        event_id TEXT NOT NULL, kind TEXT NOT NULL, model TEXT NOT NULL,
        source TEXT NOT NULL, parser_version INTEGER NOT NULL DEFAULT 1,
        coverage TEXT NOT NULL, observed_at TEXT NOT NULL,
        input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
        cache_read_tokens INTEGER NOT NULL CHECK(cache_read_tokens >= 0),
        cache_create_tokens INTEGER NOT NULL CHECK(cache_create_tokens >= 0),
        tool_calls INTEGER NOT NULL DEFAULT 0, reported_cost_usd REAL,
        UNIQUE(terminal_id, provider, external_session_id, event_id, kind)
      );
      CREATE INDEX IF NOT EXISTS usage_facts_turn ON usage_facts(turn_id);
      CREATE TABLE IF NOT EXISTS usage_checkpoints (
        terminal_id TEXT NOT NULL, provider TEXT NOT NULL, external_session_id TEXT NOT NULL,
        counter_key TEXT NOT NULL, totals TEXT NOT NULL, revision INTEGER NOT NULL,
        PRIMARY KEY(terminal_id, provider, external_session_id, counter_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS usage_one_open_turn ON usage_turns(terminal_id)
        WHERE ended_at IS NULL AND telemetry_version = 1;
      CREATE TABLE IF NOT EXISTS thread_lifecycle (
        terminal_id TEXT PRIMARY KEY, external_session_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL, source TEXT NOT NULL, observed_at TEXT NOT NULL,
        native_turn_id TEXT
      );
      CREATE VIEW IF NOT EXISTS usage_measurements AS
        SELECT t.id AS turn_id, t.terminal_id, t.project_id, t.provider, f.model,
          t.started_at, t.ended_at, t.outcome, f.input_tokens, f.output_tokens,
          f.cache_read_tokens, f.cache_create_tokens, f.reported_cost_usd,
          f.coverage, f.source
        FROM usage_facts f JOIN usage_turns t ON t.id = f.turn_id
        WHERE f.kind = 'usage' OR f.kind = 'cost'
        UNION ALL
        SELECT id, terminal_id, project_id, provider, model, started_at, ended_at, outcome,
          input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
          CASE WHEN cost_usd > 0 THEN cost_usd ELSE NULL END,
          CASE WHEN messages > 0 THEN 'partial' ELSE 'missing' END, 'legacy'
        FROM usage_turns WHERE telemetry_version = 0;
    `);
  })();
}

const valid = (v: number) => Number.isFinite(v) && v >= 0;
const keys = ['input', 'output', 'cacheRead', 'cacheCreate'] as const;

/** Facts are authoritative. Turn totals are a transactionally maintained compatibility projection. */
export function recordMeasurement(db: Database.Database, turnId: string | null, context: {
  terminalId: string; provider: string; sessionId: string; now: string;
}, measurement: Measurement): boolean {
  return db.transaction(() => {
    if (keys.some((key) => !valid(measurement[key]))) throw new Error('Invalid token measurement');
    if (measurement.reportedCostUsd != null && !valid(measurement.reportedCostUsd)) throw new Error('Invalid reported cost');
    if (turnId) {
      const turn = db.prepare('SELECT ended_at FROM usage_turns WHERE id=?').get(turnId) as { ended_at: string | null } | undefined;
      if (!turn || turn.ended_at !== null) return false;
    }
    let m = { ...measurement };
    const session = m.sessionId || context.sessionId;
    if (m.counter) {
      if (keys.some((key) => !valid(m.counter!.totals[key]))) throw new Error('Invalid cumulative counter');
      const args = [context.terminalId, context.provider, session, m.counter.key];
      const prior = db.prepare('SELECT totals, revision FROM usage_checkpoints WHERE terminal_id=? AND provider=? AND external_session_id=? AND counter_key=?')
        .get(...args) as { totals: string; revision: number } | undefined;
      const totals = m.counter.totals;
      const previous = prior ? JSON.parse(prior.totals) as Tokens : null;
      const reset = previous && keys.some((key) => totals[key] < previous[key]);
      const unchanged = previous && keys.every((key) => totals[key] === previous[key]);
      if (unchanged && (!m.counter.final || !turnId)) return false;
      const revision = unchanged ? prior!.revision : (prior?.revision ?? 0) + 1;
      db.prepare(`INSERT INTO usage_checkpoints VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(terminal_id, provider, external_session_id, counter_key)
        DO UPDATE SET totals=excluded.totals, revision=excluded.revision`).run(...args, JSON.stringify(totals), revision);
      if (m.counter.baselineOnly || !turnId) return false;
      if (reset) {
        db.prepare("UPDATE usage_turns SET coverage='partial' WHERE id=?").run(turnId);
        return false;
      }
      if (previous) for (const key of keys) m[key] = totals[key] - previous[key];
      else if (!m.counter.initialIsDelta) m.coverage = 'partial'; // only the adapter's observed last call is attributable
      if (m.counter.unit === 'usd') {
        m.reportedCostUsd = previous ? m.input : measurement.reportedCostUsd;
        m.input = 0; m.output = 0; m.cacheRead = 0; m.cacheCreate = 0;
      }
      m.eventId = unchanged ? `${m.counter.key}:zero:${turnId}` : `${m.counter.key}:${revision}`;
    }
    if (!turnId) return false;
    const turn = db.prepare('SELECT ended_at FROM usage_turns WHERE id=?').get(turnId) as { ended_at: string | null } | undefined;
    if (!turn || turn.ended_at !== null) return false;
    const eventId = m.eventId || randomUUID();
    const kind = m.kind ?? 'usage';
    const prior = db.prepare(`SELECT id, turn_id FROM usage_facts WHERE terminal_id=? AND provider=? AND external_session_id=? AND event_id=? AND kind=?`)
      .get(context.terminalId, context.provider, session, eventId, kind) as { id: string; turn_id: string } | undefined;
    // A replay from a previous turn belongs to that turn, never to the current one.
    if (prior && prior.turn_id !== turnId) return false;
    db.prepare(`INSERT INTO usage_facts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(terminal_id, provider, external_session_id, event_id, kind) DO UPDATE SET
        input_tokens=MAX(input_tokens,excluded.input_tokens), output_tokens=MAX(output_tokens,excluded.output_tokens),
        cache_read_tokens=MAX(cache_read_tokens,excluded.cache_read_tokens), cache_create_tokens=MAX(cache_create_tokens,excluded.cache_create_tokens),
        tool_calls=MAX(tool_calls,excluded.tool_calls), reported_cost_usd=COALESCE(excluded.reported_cost_usd,reported_cost_usd)
    `).run(prior?.id ?? randomUUID(), turnId, context.terminalId, context.provider, session, eventId, kind, m.model,
      m.source, m.coverage ?? (m.eventId ? 'reported' : 'partial'), context.now,
      m.input, m.output, m.cacheRead, m.cacheCreate, m.toolCalls ?? 0, m.reportedCostUsd ?? null);
    refreshTurn(db, turnId);
    return true;
  })();
}

export function refreshTurn(db: Database.Database, turnId: string): void {
  db.prepare(`UPDATE usage_turns SET
    input_tokens=(SELECT COALESCE(SUM(input_tokens),0) FROM usage_facts WHERE turn_id=?),
    output_tokens=(SELECT COALESCE(SUM(output_tokens),0) FROM usage_facts WHERE turn_id=?),
    cache_read_tokens=(SELECT COALESCE(SUM(cache_read_tokens),0) FROM usage_facts WHERE turn_id=?),
    cache_create_tokens=(SELECT COALESCE(SUM(cache_create_tokens),0) FROM usage_facts WHERE turn_id=?),
    tool_calls=(SELECT COALESCE(SUM(tool_calls),0) FROM usage_facts WHERE turn_id=?),
    messages=(SELECT COUNT(*) FROM usage_facts WHERE turn_id=? AND kind='usage'),
    reported_cost_usd=(SELECT SUM(reported_cost_usd) FROM usage_facts WHERE turn_id=?),
    cost_usd=COALESCE((SELECT SUM(reported_cost_usd) FROM usage_facts WHERE turn_id=?),0),
    coverage=CASE WHEN coverage='partial' OR EXISTS(SELECT 1 FROM usage_facts WHERE turn_id=? AND coverage='partial') THEN 'partial'
      WHEN EXISTS(SELECT 1 FROM usage_facts WHERE turn_id=? AND kind='usage') THEN 'reported' ELSE coverage END
    WHERE id=?`).run(...Array(11).fill(turnId));
}
