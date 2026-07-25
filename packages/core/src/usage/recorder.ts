import type Database from 'better-sqlite3';

/**
 * Per-day token usage for interactive threads.
 *
 * Dispatch already captures usage for SCHEDULED runs (agents/run-stream.ts writes
 * cost/tokens onto agent_runs), but interactive structured threads — which is all of
 * Surface A — discarded theirs. That left no way to answer the question a hosted
 * fleet actually needs answered.
 *
 * And the question is **rate limits, not cost**. Subscriptions are flat-fee with
 * weekly caps, so nobody is watching a bill; what bites is a user quietly exhausting
 * their weekly allowance — which is shared with the Claude chat app, so they lose
 * that too. Usage is therefore bucketed by day AND model, because a Sonnet token and
 * an Opus token consume very different fractions of a cap.
 *
 * Deliberately aggregate, not per-thread: the consumer is a fleet view answering
 * "who is close to their limit", and per-thread rows would grow without bound for a
 * number nobody reads at that grain.
 */

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

export interface UsageByModel extends UsageTotals {
  model: string;
}

export function initUsageSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_daily (
      day           TEXT NOT NULL,
      model         TEXT NOT NULL,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      turns         INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, model)
    );
  `);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** The model a result event used, or 'unknown'. Shape mirrors run-stream's firstModel. */
export function modelOf(event: any): string {
  const usage = event?.modelUsage;
  if (usage && typeof usage === 'object') {
    const first = Object.keys(usage)[0];
    if (first) return first;
  }
  return typeof event?.model === 'string' ? event.model : 'unknown';
}

export class UsageRecorder {
  constructor(private readonly db: Database.Database, private readonly now: () => Date = () => new Date()) {
    initUsageSchema(db);
  }

  /**
   * Fold one structured event into the daily totals. Only `result` events carry
   * usage; everything else is ignored, so this can be wired to the raw event
   * stream without filtering at the call site.
   */
  observe(event: any): void {
    if (!event || event.type !== 'result') return;
    const usage = event.usage ?? {};
    const input = num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
    const output = num(usage.output_tokens);
    if (input === 0 && output === 0) return;

    const day = this.now().toISOString().slice(0, 10);
    try {
      this.db
        .prepare(
          `INSERT INTO usage_daily (day, model, input_tokens, output_tokens, turns)
           VALUES (?, ?, ?, ?, 1)
           ON CONFLICT(day, model) DO UPDATE SET
             input_tokens  = input_tokens  + excluded.input_tokens,
             output_tokens = output_tokens + excluded.output_tokens,
             turns         = turns + 1`,
        )
        .run(day, modelOf(event), input, output);
    } catch {
      // Telemetry must never break a turn. A dropped sample is acceptable; an
      // exception propagating into the event stream is not.
    }
  }

  /** Totals for the trailing `days` days, split by model. */
  byModel(days = 7): UsageByModel[] {
    const since = new Date(this.now().getTime() - days * 86_400_000).toISOString().slice(0, 10);
    try {
      return this.db
        .prepare(
          `SELECT model,
                  SUM(input_tokens)  AS inputTokens,
                  SUM(output_tokens) AS outputTokens,
                  SUM(turns)         AS turns
             FROM usage_daily WHERE day >= ?
            GROUP BY model ORDER BY outputTokens DESC`,
        )
        .all(since) as UsageByModel[];
    } catch {
      return [];
    }
  }

  /** Combined totals for the trailing `days` days. */
  total(days = 7): UsageTotals {
    return this.byModel(days).reduce<UsageTotals>(
      (acc, m) => ({
        inputTokens: acc.inputTokens + m.inputTokens,
        outputTokens: acc.outputTokens + m.outputTokens,
        turns: acc.turns + m.turns,
      }),
      { inputTokens: 0, outputTokens: 0, turns: 0 },
    );
  }
}
