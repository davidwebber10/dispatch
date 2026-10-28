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
const FIRED = { fired: true }; // the scheduler has just started a run

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
  it('refuses a cron with a short gap inside a cluster of runs, whatever the time of the check', () => {
    const prev = process.env.DISPATCH_MIN_SCHEDULE_MINUTES;
    try {
      process.env.DISPATCH_MIN_SCHEDULE_MINUTES = '5';
      for (const now of ['2026-06-19T11:59:00.000Z', '2026-06-19T12:00:00.000Z', '2026-06-19T12:00:30.000Z', '2026-06-19T12:01:00.000Z']) {
        expect(scheduleTooFrequent(rule({ type: 'cron', expr: '0,1 * * * *' }), now), now).toMatch(/DISPATCH_MIN_SCHEDULE_MINUTES/);
        expect(scheduleTooFrequent(rule({ type: 'cron', expr: '0,1 9 * * *' }), now), now).not.toBeNull();
        for (const ok of ['*/5 * * * *', '0 * * * *', '0,30 * * * *', '0 9 * * *', '0 9 * * 1-5', '15 3 1 * *']) {
          expect(scheduleTooFrequent(rule({ type: 'cron', expr: ok }), now), `${ok} at ${now}`).toBeNull();
        }
      }
    } finally { if (prev === undefined) delete process.env.DISPATCH_MIN_SCHEDULE_MINUTES; else process.env.DISPATCH_MIN_SCHEDULE_MINUTES = prev; }
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
  describe('a stored cron rule is held to the minimum at run time, like an interval', () => {
    const withMin = (value: string | undefined, fn: () => void) => {
      const prev = process.env.DISPATCH_MIN_SCHEDULE_MINUTES;
      if (value === undefined) delete process.env.DISPATCH_MIN_SCHEDULE_MINUTES; else process.env.DISPATCH_MIN_SCHEDULE_MINUTES = value;
      try { fn(); } finally { if (prev === undefined) delete process.env.DISPATCH_MIN_SCHEDULE_MINUTES; else process.env.DISPATCH_MIN_SCHEDULE_MINUTES = prev; }
    };
    const cron = (expr: string) => sched({ recurrence_rule: rule({ type: 'cron', expr }) });
    it('an every-minute cron still fires on the next minute at the default minimum', () => {
      withMin(undefined, () => expect(computeNextRunAt(cron('* * * * *'), NOW)).toBe('2026-06-19T12:01:00.000Z'));
      withMin(undefined, () => expect(computeNextRunAt(cron('* * * * *'), '2026-06-19T12:00:30.500Z')).toBe('2026-06-19T12:01:00.000Z'));
    });
    it('a cron that is denser than a raised minimum waits for the minimum', () => {
      withMin('5', () => {
        expect(computeNextRunAt(cron('* * * * *'), NOW)).toBe('2026-06-19T12:05:00.000Z');
        expect(computeNextRunAt(cron('* * * * *'), '2026-06-19T12:00:30.500Z')).toBe('2026-06-19T12:05:00.000Z');
        expect(computeNextRunAt(cron('*/2 * * * *'), NOW)).toBe('2026-06-19T12:06:00.000Z');
      });
    });
    it('a cron that is already sparse enough is not delayed', () => {
      withMin('15', () => {
        expect(computeNextRunAt(cron('0 9 * * *'), '2026-06-19T08:55:00.000Z')).toBe('2026-06-19T09:00:00.000Z');
        expect(computeNextRunAt(cron('*/15 * * * *'), '2026-06-19T12:01:00.000Z')).toBe('2026-06-19T12:15:00.000Z');
      });
    });
    it('an irregular cron is held to the minimum after the run that just fired', () => {
      withMin('5', () => {
        // 0,1 * * * *: the run at 12:00 would be followed by 12:01 (a 1 minute gap), so the next run is the next hour.
        const fired = sched({ recurrence_rule: rule({ type: 'cron', expr: '0,1 * * * *' }), next_run_at: '2026-06-19T12:00:00.000Z' });
        expect(computeNextRunAt(fired, '2026-06-19T12:00:20.000Z', FIRED)).toBe('2026-06-19T13:00:00.000Z');
        // A late tick is still counted from the run that was due.
        expect(computeNextRunAt(fired, '2026-06-19T12:03:10.000Z', FIRED)).toBe('2026-06-19T13:00:00.000Z');
        // The same rule with a gap of five minutes or more is left alone.
        const sparse = sched({ recurrence_rule: rule({ type: 'cron', expr: '0,5 * * * *' }), next_run_at: '2026-06-19T12:00:00.000Z' });
        expect(computeNextRunAt(sparse, '2026-06-19T12:00:20.000Z', FIRED)).toBe('2026-06-19T12:05:00.000Z');
        // A daily cron is never delayed, even when the tick is late.
        const daily = sched({ recurrence_rule: rule({ type: 'cron', expr: '0 9 * * *' }), next_run_at: '2026-06-19T09:00:00.000Z' });
        expect(computeNextRunAt(daily, '2026-06-19T09:00:45.000Z', FIRED)).toBe('2026-06-20T09:00:00.000Z');
      });
    });
    it('a late tick of a dense cron is counted from this minute, not from the overdue due time', () => {
      withMin('5', () => {
        const late = sched({ recurrence_rule: rule({ type: 'cron', expr: '* * * * *' }), next_run_at: '2026-06-19T12:00:00.000Z' });
        expect(computeNextRunAt(late, '2026-06-19T12:04:50.000Z', FIRED)).toBe('2026-06-19T12:09:00.000Z');
        const lateIrregular = sched({ recurrence_rule: rule({ type: 'cron', expr: '0,1,2,3,4,5 * * * *' }), next_run_at: '2026-06-19T12:00:00.000Z' });
        expect(computeNextRunAt(lateIrregular, '2026-06-19T12:04:50.000Z', FIRED)).toBe('2026-06-19T13:00:00.000Z');
      });
    });
    it('a very late tick (asleep, or a long run) is counted from when it ran', () => {
      withMin('5', () => {
        const asleep = sched({ recurrence_rule: rule({ type: 'cron', expr: '* * * * *' }), next_run_at: '2026-06-19T12:00:00.000Z' });
        expect(computeNextRunAt(asleep, '2026-06-19T12:20:10.000Z', FIRED)).toBe('2026-06-19T12:25:00.000Z');
        const busy = sched({ recurrence_rule: rule({ type: 'cron', expr: '0,1 * * * *' }), next_run_at: '2026-06-19T11:01:00.000Z' });
        expect(computeNextRunAt(busy, '2026-06-19T11:59:30.000Z', FIRED)).toBe('2026-06-19T13:00:00.000Z');
      });
    });
    it('an edit or a create while next_run_at is overdue does not delay a normal rule', () => {
      withMin('5', () => {
        // Due at 09:00 with its run still active; at 09:01 the rule is changed to 3 * * * *.
        const edited = sched({ recurrence_rule: rule({ type: 'cron', expr: '3 * * * *' }), next_run_at: '2026-06-19T09:00:00.000Z' });
        expect(computeNextRunAt(edited, '2026-06-19T09:01:00.000Z')).toBe('2026-06-19T09:03:00.000Z');
        const daily = sched({ recurrence_rule: rule({ type: 'cron', expr: '3 9 * * *' }), next_run_at: '2026-06-19T09:00:00.000Z' });
        expect(computeNextRunAt(daily, '2026-06-19T09:01:00.000Z')).toBe('2026-06-19T09:03:00.000Z');
      });
    });
    it('0 turns the clamp off', () => {
      withMin('0', () => expect(computeNextRunAt(cron('* * * * *'), NOW)).toBe('2026-06-19T12:01:00.000Z'));
    });
  });
});
