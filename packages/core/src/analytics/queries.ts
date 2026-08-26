import type Database from 'better-sqlite3';
import { notionalValueUsd } from './pricing.js';

export type Metric = 'tokens' | 'outputTokens' | 'turns' | 'duration';
export type GroupBy = 'model' | 'provider' | 'project' | 'outcome' | 'none';
export type Dimension = 'project' | 'thread' | 'model';

export interface Range { from?: string; to?: string; projectId?: string; provider?: string }

export interface Summary {
  turns: number;
  threads: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  totalTokens: number;
  /**
   * Turns that closed without a single usage-bearing frame (`messages = 0`).
   *
   * This is NOT the same as a turn that used zero tokens. A Codex turn can settle
   * through the error path without ever emitting a `tokenUsage` frame
   * (`structured/codex-translate.ts:320-326` settles straight to idle), and a PTY
   * thread emits no frames at all. Those turns really did consume tokens; we
   * simply never saw a count. The spec forbids showing that as a measured zero,
   * so the UI reports this number separately as "turns that reported no usage".
   */
  unreportedTurns: number;
  /**
   * How many of `turns` came from the history importer.
   *
   * These rows are NOT the same unit as a measured turn. A transcript records no
   * turn boundaries, so importer.ts writes one row per assistant MESSAGE. Their
   * tokens are real and belong in every token total, but counting them as turns
   * silently mixes a message count into a turn count — so the UI labels the TURNS
   * tile whenever this is non-zero rather than letting the reader assume.
   */
  backfilledTurns: number;
  /**
   * The "equivalent API value" of the range, in dollars — a NOTIONAL figure (on a
   * subscription no dollars change hands), never to be labelled "cost" or "spend".
   *
   * One rule per model: a model pricing.ts knows is valued at list rates; a model
   * it does not know is valued at the cost its provider actually reported
   * (cost_usd — OpenCode's ACP per-turn delta); a model with neither contributes
   * tokens but no dollars and sets `valueIsPartial` instead. Reported cost is
   * never ADDED on top of a priced model's notional figure — one source per
   * model, so nothing can double-value.
   */
  apiValueUsd: number;
  /** True when tokens exist in the range that carry no price and no reported cost. */
  valueIsPartial: boolean;
}

export interface SeriesPoint { day: string; key: string; value: number }
export interface TopRow { key: string; label: string; value: number }
export interface Records {
  totalTokens: number;
  totalTurns: number;
  busiestDay: string | null;
  busiestDayTokens: number;
  topModel: string | null;
  activeDays: number;
  longestTurnSeconds: number;
}

/**
 * Build the shared WHERE clause. Every query filters identically.
 *
 * `alias`, when given, prefixes the filtered columns with a table alias (e.g.
 * `u.`) so the clause can be reused in a query that joins usage_turns against
 * another table. This is structural (a plain string built from a fixed set of
 * known column names), not textual rewriting of arbitrary SQL, so there is no
 * risk of an unintended substring match elsewhere in the query.
 */
function where(r: Range, alias?: string): { sql: string; params: unknown[] } {
  const col = (name: string) => (alias ? `${alias}.${name}` : name);
  const parts = [`${col('ended_at')} IS NOT NULL`];
  const params: unknown[] = [];
  if (r.from) { parts.push(`${col('started_at')} >= ?`); params.push(r.from); }
  if (r.to) { parts.push(`${col('started_at')} < ?`); params.push(r.to); }
  if (r.projectId) { parts.push(`${col('project_id')} = ?`); params.push(r.projectId); }
  if (r.provider) { parts.push(`${col('provider')} = ?`); params.push(r.provider); }
  return { sql: parts.join(' AND '), params };
}

export function summary(db: Database.Database, r: Range): Summary {
  const w = where(r);
  const agg = db.prepare(`
    SELECT COUNT(*) AS turns, COUNT(DISTINCT terminal_id) AS threads,
           COALESCE(SUM(CASE WHEN messages = 0 THEN 1 ELSE 0 END), 0) AS unreported_turns,
           COALESCE(SUM(backfilled), 0)          AS backfilled_turns,
           COALESCE(SUM(input_tokens), 0)        AS input_tokens,
           COALESCE(SUM(output_tokens), 0)       AS output_tokens,
           COALESCE(SUM(cache_read_tokens), 0)   AS cache_read_tokens,
           COALESCE(SUM(cache_create_tokens), 0) AS cache_create_tokens
    FROM usage_turns WHERE ${w.sql}
  `).get(...w.params) as Record<string, number>;

  // Per-model sums, folded through pricing.ts in JS: SQLite cannot hold the
  // price table, and the fold is over at most a handful of model groups.
  const byModel = db.prepare(`
    SELECT model,
           COALESCE(SUM(input_tokens), 0)        AS input,
           COALESCE(SUM(output_tokens), 0)       AS output,
           COALESCE(SUM(cache_read_tokens), 0)   AS cache_read,
           COALESCE(SUM(cache_create_tokens), 0) AS cache_create,
           COALESCE(SUM(cost_usd), 0)            AS cost_usd
    FROM usage_turns WHERE ${w.sql} GROUP BY model
  `).all(...w.params) as { model: string; input: number; output: number; cache_read: number; cache_create: number; cost_usd: number }[];

  let apiValueUsd = 0;
  let valueIsPartial = false;
  for (const g of byModel) {
    const notional = notionalValueUsd({
      model: g.model, input: g.input, output: g.output, cacheRead: g.cache_read, cacheCreate: g.cache_create,
    });
    if (notional !== null) { apiValueUsd += notional; continue; }
    if (g.cost_usd > 0) { apiValueUsd += g.cost_usd; continue; }
    // Tokens with no price and no reported cost: contribute nothing, but say so.
    if (g.input + g.output + g.cache_read + g.cache_create > 0) valueIsPartial = true;
  }

  return {
    turns: agg.turns,
    threads: agg.threads,
    inputTokens: agg.input_tokens,
    outputTokens: agg.output_tokens,
    cacheReadTokens: agg.cache_read_tokens,
    cacheCreateTokens: agg.cache_create_tokens,
    totalTokens: agg.input_tokens + agg.output_tokens + agg.cache_read_tokens + agg.cache_create_tokens,
    unreportedTurns: agg.unreported_turns,
    backfilledTurns: agg.backfilled_turns,
    apiValueUsd,
    valueIsPartial,
  };
}

const GROUP_COLUMN: Record<Exclude<GroupBy, 'none'>, string> = {
  model: 'model', provider: 'provider', project: 'project_id', outcome: 'outcome',
};

export function series(
  db: Database.Database,
  r: Range & { metric: Metric; groupBy: GroupBy },
): SeriesPoint[] {
  const w = where(r);
  const key = r.groupBy === 'none' ? `''` : GROUP_COLUMN[r.groupBy];

  // Day buckets are LOCAL time: 'localtime' converts before the date is taken, so a
  // 22:00 turn lands on the day the human worked, not the following UTC day.
  const day = `date(started_at, 'localtime')`;

  if (r.metric === 'duration') {
    // Mean seconds per bucket, over turns that actually have a duration. An
    // interrupted row has ended_at == started_at and is excluded, so a restart
    // cannot drag the average down.
    return db.prepare(`
      SELECT ${day} AS day, ${key} AS key,
             CAST(ROUND(AVG((julianday(ended_at) - julianday(started_at)) * 86400.0)) AS INTEGER) AS value
      FROM usage_turns
      WHERE ${w.sql} AND ended_at > started_at
      GROUP BY day, key ORDER BY day
    `).all(...w.params) as SeriesPoint[];
  }

  const value = r.metric === 'turns' ? 'COUNT(*)'
    : r.metric === 'outputTokens' ? 'SUM(output_tokens)'
    : 'SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens)';

  return db.prepare(`
    SELECT ${day} AS day, ${key} AS key, COALESCE(${value}, 0) AS value
    FROM usage_turns WHERE ${w.sql}
    GROUP BY day, key ORDER BY day
  `).all(...w.params) as SeriesPoint[];
}

export function top(db: Database.Database, r: Range & { dimension: Dimension; limit?: number }): TopRow[] {
  const limit = r.limit ?? 10;

  if (r.dimension === 'model') {
    const w = where(r);
    return db.prepare(`
      SELECT model AS key, model AS label,
             SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens) AS value
      FROM usage_turns WHERE ${w.sql} GROUP BY model ORDER BY value DESC LIMIT ?
    `).all(...w.params, limit) as TopRow[];
  }

  if (r.dimension === 'thread') {
    const w = where(r, 'u');
    return db.prepare(`
      SELECT u.terminal_id AS key, COALESCE(t.label, u.terminal_id) AS label,
             SUM(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_create_tokens) AS value
      FROM usage_turns u LEFT JOIN terminals t ON t.id = u.terminal_id
      WHERE ${w.sql}
      GROUP BY u.terminal_id ORDER BY value DESC LIMIT ?
    `).all(...w.params, limit) as TopRow[];
  }

  const w = where(r, 'u');
  return db.prepare(`
    SELECT u.project_id AS key, COALESCE(s.name, u.project_id) AS label,
           SUM(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_create_tokens) AS value
    FROM usage_turns u LEFT JOIN sessions s ON s.id = u.project_id
    WHERE ${w.sql}
    GROUP BY u.project_id ORDER BY value DESC LIMIT ?
  `).all(...w.params, limit) as TopRow[];
}

export function records(db: Database.Database): Records {
  const s = summary(db, {});
  const busiest = db.prepare(`
    SELECT date(started_at, 'localtime') AS day,
           SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens) AS value
    FROM usage_turns WHERE ended_at IS NOT NULL
    GROUP BY day ORDER BY value DESC LIMIT 1
  `).get() as { day: string; value: number } | undefined;

  const topModel = top(db, { dimension: 'model', limit: 1 })[0]?.key ?? null;

  const activeDays = (db.prepare(`
    SELECT COUNT(DISTINCT date(started_at, 'localtime')) AS n
    FROM usage_turns WHERE ended_at IS NOT NULL
  `).get() as { n: number }).n;

  const longest = (db.prepare(`
    SELECT COALESCE(MAX((julianday(ended_at) - julianday(started_at)) * 86400.0), 0) AS s
    FROM usage_turns WHERE ended_at > started_at
  `).get() as { s: number }).s;

  return {
    totalTokens: s.totalTokens,
    totalTurns: s.turns,
    busiestDay: busiest?.day ?? null,
    busiestDayTokens: busiest?.value ?? 0,
    topModel,
    activeDays,
    longestTurnSeconds: Math.round(longest),
  };
}
