import type Database from 'better-sqlite3';

export interface UsageTotals { inputTokens: number; outputTokens: number; turns: number }
export interface UsageByModel extends UsageTotals { model: string }

/** Compatibility name for the fleet reader. Collection belongs exclusively to analytics. */
export class UsageRecorder {
  constructor(private readonly db: Database.Database, private readonly now: () => Date = () => new Date()) {}

  byModel(days = 7): UsageByModel[] {
    const since = new Date(this.now().getTime() - days * 86_400_000).toISOString();
    return this.db.prepare(`SELECT model,
      SUM(input_tokens + cache_read_tokens + cache_create_tokens) AS inputTokens,
      SUM(output_tokens) AS outputTokens, COUNT(DISTINCT turn_id) AS turns
      FROM usage_measurements WHERE ended_at IS NOT NULL AND started_at >= ?
      GROUP BY model ORDER BY outputTokens DESC`).all(since) as UsageByModel[];
  }

  total(days = 7): UsageTotals {
    const since = new Date(this.now().getTime() - days * 86_400_000).toISOString();
    const values = this.byModel(days);
    const turns = (this.db.prepare('SELECT COUNT(*) AS n FROM usage_turns WHERE ended_at IS NOT NULL AND started_at >= ?').get(since) as { n: number }).n;
    return { inputTokens: values.reduce((n,v) => n+v.inputTokens,0), outputTokens: values.reduce((n,v) => n+v.outputTokens,0), turns };
  }
}
