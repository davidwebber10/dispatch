import { describe, it, expect } from 'vitest';
import { computeNextRunAt, scheduleTooFrequent } from '../../src/agents/recurrence.js';
import type { AgentScheduleRow } from '../../src/db/agents.js';

function sched(overrides: Partial<AgentScheduleRow>): AgentScheduleRow {
  return {
    id: 's', project_id: 'p', name: 'n', provider: 'claude-code', working_dir: '/',
    prompt: '', schedule_kind: 'recurring', run_at: null, recurrence_rule: null,
    timezone: 'UTC', enabled: 1, next_run_at: null, default_terminal_label: null,
    created_at: '', updated_at: '', ...overrides,
  };
}

const NOW = '2026-06-19T12:00:00.000Z'; // Fri 12:00 UTC

describe('computeNextRunAt', () => {
  it('manual / null never fires', () => {
    expect(computeNextRunAt(sched({ recurrence_rule: '{"type":"manual"}' }), NOW)).toBeNull();
    expect(computeNextRunAt(sched({ recurrence_rule: null }), NOW)).toBeNull();
  });

  it('interval every N minutes/hours', () => {
    expect(computeNextRunAt(sched({ recurrence_rule: '{"type":"interval","everyMinutes":90}' }), NOW))
      .toBe('2026-06-19T13:30:00.000Z');
    expect(computeNextRunAt(sched({ recurrence_rule: '{"type":"interval-hours","hours":6}' }), NOW))
      .toBe('2026-06-19T18:00:00.000Z');
  });

  it('daily picks today if still ahead, else tomorrow (UTC)', () => {
    expect(computeNextRunAt(sched({ recurrence_rule: '{"type":"daily","time":"15:30"}' }), NOW))
      .toBe('2026-06-19T15:30:00.000Z');
    expect(computeNextRunAt(sched({ recurrence_rule: '{"type":"daily","time":"09:00"}' }), NOW))
      .toBe('2026-06-20T09:00:00.000Z');
  });

  it('daily respects timezone', () => {
    // 09:00 America/Indianapolis (UTC-4 in June) = 13:00 UTC, still ahead of 12:00 UTC now.
    expect(computeNextRunAt(sched({ recurrence_rule: '{"type":"daily","time":"09:00"}', timezone: 'America/Indianapolis' }), NOW))
      .toBe('2026-06-19T13:00:00.000Z');
  });

  it('weekly fires on the next selected weekday', () => {
    // Mon(1)..Fri(5) at 09:00 UTC; now is Fri 12:00 → next is Mon 09:00.
    expect(computeNextRunAt(sched({ recurrence_rule: '{"type":"weekly","days":[1,2,3,4,5],"time":"09:00"}' }), NOW))
      .toBe('2026-06-22T09:00:00.000Z');
    // Same but 15:00 today (Fri is selected) → today.
    expect(computeNextRunAt(sched({ recurrence_rule: '{"type":"weekly","days":[1,2,3,4,5],"time":"15:00"}' }), NOW))
      .toBe('2026-06-19T15:00:00.000Z');
  });

  it('cron: weekdays at 09:00', () => {
    expect(computeNextRunAt(sched({ recurrence_rule: '{"type":"cron","expr":"0 9 * * 1-5"}' }), NOW))
      .toBe('2026-06-22T09:00:00.000Z');
  });

  it('cron: every 15 minutes', () => {
    expect(computeNextRunAt(sched({ recurrence_rule: '{"type":"cron","expr":"*/15 * * * *"}' }), NOW))
      .toBe('2026-06-19T12:15:00.000Z');
  });

  it('one-shot fires at run_at when in the future, else null', () => {
    expect(computeNextRunAt(sched({ schedule_kind: 'one-shot', run_at: '2026-06-19T18:00:00.000Z' }), NOW))
      .toBe('2026-06-19T18:00:00.000Z');
    expect(computeNextRunAt(sched({ schedule_kind: 'one-shot', run_at: '2026-06-19T06:00:00.000Z' }), NOW))
      .toBeNull();
  });

  it('invalid rules return null', () => {
    expect(computeNextRunAt(sched({ recurrence_rule: 'not json' }), NOW)).toBeNull();
    expect(computeNextRunAt(sched({ recurrence_rule: '{"type":"cron","expr":"bad"}' }), NOW)).toBeNull();
  });
});

describe('minimum schedule interval (SEC-23)', () => {
  const rule = (r: object) => JSON.stringify(r);
  it('refuses a rule that runs more often than once a minute, and says which setting changes it', () => {
    expect(scheduleTooFrequent(rule({ type: 'interval', everyMinutes: 0.01 }))).toMatch(/shortest allowed gap is 1 minute.*DISPATCH_MIN_SCHEDULE_MINUTES/);
    expect(scheduleTooFrequent(rule({ type: 'interval-hours', hours: 0.001 }))).not.toBeNull();
  });
  it('allows what people really use: every minute, every hour, daily, weekly, a cron of every five minutes', () => {
    for (const r of [
      { type: 'interval', everyMinutes: 1 }, { type: 'interval', everyMinutes: 90 }, { type: 'interval-hours', hours: 6 },
      { type: 'daily', time: '09:00' }, { type: 'weekly', days: [1], time: '09:00' }, { type: 'manual' },
      { type: 'cron', expr: '*/5 * * * *' }, { type: 'cron', expr: '* * * * *' },
    ]) expect(scheduleTooFrequent(rule(r)), JSON.stringify(r)).toBeNull();
    expect(scheduleTooFrequent(null)).toBeNull();
    expect(scheduleTooFrequent('not json')).toBeNull();
  });
  it('DISPATCH_MIN_SCHEDULE_MINUTES raises the floor for intervals and cron; 0 turns it off', () => {
    const prev = process.env.DISPATCH_MIN_SCHEDULE_MINUTES;
    try {
      process.env.DISPATCH_MIN_SCHEDULE_MINUTES = '15';
      expect(scheduleTooFrequent(rule({ type: 'interval', everyMinutes: 10 }))).not.toBeNull();
      expect(scheduleTooFrequent(rule({ type: 'cron', expr: '*/5 * * * *' }))).not.toBeNull();
      expect(scheduleTooFrequent(rule({ type: 'interval', everyMinutes: 15 }))).toBeNull();
      process.env.DISPATCH_MIN_SCHEDULE_MINUTES = '0';
      expect(scheduleTooFrequent(rule({ type: 'interval', everyMinutes: 0.01 }))).toBeNull();
    } finally { if (prev === undefined) delete process.env.DISPATCH_MIN_SCHEDULE_MINUTES; else process.env.DISPATCH_MIN_SCHEDULE_MINUTES = prev; }
  });
  it('a stored schedule with a shorter gap still runs, no more often than the minimum', () => {
    const next = computeNextRunAt(sched({ recurrence_rule: rule({ type: 'interval', everyMinutes: 0.01 }) }), NOW);
    expect(next).toBe('2026-06-19T12:01:00.000Z');
  });
});
