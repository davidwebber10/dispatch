import type Database from 'better-sqlite3';

export interface TurnRow {
  id: string;
  terminal_id: string;
  project_id: string;
  provider: string;
  model: string;
  role: string;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  messages: number;
  tool_calls: number;
  backfilled: number;
  /** Provider-reported per-turn dollars (OpenCode's ACP cost delta). 0 = none reported. */
  cost_usd: number;
}

export interface OpenTurnInput {
  id: string;
  terminalId: string;
  projectId: string;
  provider: string;
  model: string;
  role: string;
  startedAt: string;
}

export interface UsageDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  messages: number;
  toolCalls: number;
}

export interface ClosedTurnInput extends OpenTurnInput, UsageDelta {
  endedAt: string;
  outcome: string;
  backfilled: boolean;
  costUsd?: number;
}

export function openTurn(db: Database.Database, input: OpenTurnInput): void {
  db.prepare(`
    INSERT INTO usage_turns (id, terminal_id, project_id, provider, model, role, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(input.id, input.terminalId, input.projectId, input.provider, input.model, input.role, input.startedAt);
}

/** The newest still-open turn for a terminal, or null. */
export function findOpenTurn(db: Database.Database, terminalId: string): TurnRow | null {
  const result = db.prepare(`
    SELECT * FROM usage_turns
    WHERE terminal_id = ? AND ended_at IS NULL
    ORDER BY started_at DESC LIMIT 1
  `).get(terminalId) as TurnRow | undefined;
  return result ?? null;
}

/**
 * Add a frame's usage to an open turn. Deliberately additive SQL rather than a
 * read-modify-write in JS: the recorder writes through on every frame, so a
 * daemon restart mid-turn loses nothing, and there is no in-memory counter that
 * could drift from the row.
 */
export function addUsage(db: Database.Database, turnId: string, d: UsageDelta): void {
  db.prepare(`
    UPDATE usage_turns SET
      input_tokens        = input_tokens        + ?,
      output_tokens       = output_tokens       + ?,
      cache_read_tokens   = cache_read_tokens   + ?,
      cache_create_tokens = cache_create_tokens + ?,
      messages            = messages            + ?,
      tool_calls          = tool_calls          + ?
    WHERE id = ?
  `).run(d.input, d.output, d.cacheRead, d.cacheCreate, d.messages, d.toolCalls, turnId);
}

/**
 * Set the model a frame reported on its turn. Unconditional, and deliberately so.
 *
 * The turn OPENS with `terminal.config.model`, which for a Claude thread is a
 * bare CLI tier alias — 'sonnet', 'opus', 'haiku', 'fable' (overseer/prompts.ts
 * MODEL_FOR_TYPE) — not a model id. The frame carries the authoritative full id
 * ('claude-sonnet-5'), so the frame wins. A fill-only variant would pin the alias
 * forever: the same model would split every by-model chart across two keys, and
 * pricing.ts (still consulted by the state route's cost chip) could not price it.
 *
 * Callers must only call this when the frame actually named a model. Codex frames
 * carry no `message.model` (structured/codex-translate.ts names a model only in
 * its `init` frame, which carries no usage), so a Codex slug from config survives.
 */
export function setModel(db: Database.Database, turnId: string, model: string): void {
  db.prepare(`UPDATE usage_turns SET model = ? WHERE id = ?`).run(model, turnId);
}

/**
 * Add a provider-reported per-turn cost to an open turn. Additive for the same
 * reason addUsage is: write-through, no in-memory counter to drift. Callers must
 * only pass translator-owned PER-TURN deltas — a session-cumulative figure
 * (Claude's result footer) summed per turn would multiply the real number.
 */
export function addCost(db: Database.Database, turnId: string, usd: number): void {
  db.prepare(`UPDATE usage_turns SET cost_usd = cost_usd + ? WHERE id = ?`).run(usd, turnId);
}

export function closeTurn(db: Database.Database, turnId: string, at: string, outcome: string): void {
  db.prepare(`UPDATE usage_turns SET ended_at = ?, outcome = ? WHERE id = ? AND ended_at IS NULL`)
    .run(at, outcome, turnId);
}

export function insertClosed(db: Database.Database, r: ClosedTurnInput): void {
  db.prepare(`
    INSERT INTO usage_turns (
      id, terminal_id, project_id, provider, model, role, started_at, ended_at, outcome,
      input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, messages, tool_calls, backfilled, cost_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    r.id, r.terminalId, r.projectId, r.provider, r.model, r.role, r.startedAt, r.endedAt, r.outcome,
    r.input, r.output, r.cacheRead, r.cacheCreate, r.messages, r.toolCalls, r.backfilled ? 1 : 0, r.costUsd ?? 0,
  );
}

/**
 * How many imported rows exist, over all time and every project.
 *
 * The history panel needs this rather than the range-filtered figure from
 * summary(): the "Remove imported history" control acts on the whole table, so
 * hiding it because the reader happens to be looking at the last 7 days would
 * strand a user who imported older history.
 */
export function countBackfilled(db: Database.Database): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM usage_turns WHERE backfilled = 1`).get() as { n: number }).n;
}

export function deleteBackfilled(db: Database.Database): number {
  return db.prepare(`DELETE FROM usage_turns WHERE backfilled = 1`).run().changes;
}
