import { describe, it, expect } from 'vitest';
import { aggregateSessionStatus } from '../../src/status/aggregate.js';

describe('aggregateSessionStatus', () => {
  it('returns waiting for no terminals or all waiting', () => {
    expect(aggregateSessionStatus([])).toBe('waiting');
    expect(aggregateSessionStatus(['waiting', 'waiting'])).toBe('waiting');
  });

  it('needs_input wins over everything (most actionable)', () => {
    expect(aggregateSessionStatus(['working', 'needs_input', 'waiting'])).toBe('needs_input');
    expect(aggregateSessionStatus(['error', 'needs_input'])).toBe('needs_input');
  });

  it('working wins over error and waiting (project is still active)', () => {
    expect(aggregateSessionStatus(['waiting', 'working'])).toBe('working');
    expect(aggregateSessionStatus(['error', 'working'])).toBe('working');
  });

  it('error wins over waiting only', () => {
    expect(aggregateSessionStatus(['waiting', 'error'])).toBe('error');
  });

  it('treats missing/empty terminal status as waiting', () => {
    expect(aggregateSessionStatus(['', 'working'])).toBe('working');
    expect(aggregateSessionStatus(['', ''])).toBe('waiting');
  });

  // 'scheduled' = a dormant thread mid-wait on ScheduleWakeup/CronCreate (see
  // structured/manager.ts). It hasn't finished, so it must not silently read as
  // 'waiting' (== idle/done here) — but SessionStatus has no dedicated slot for it, so
  // it folds into 'working', ranked below an actually-active/needs_input terminal.
  it('scheduled (dormant) folds into working — never collapses to waiting/done', () => {
    expect(aggregateSessionStatus(['scheduled'])).toBe('working');
  });

  it('an actively-working or needs_input terminal still outranks a scheduled one', () => {
    expect(aggregateSessionStatus(['scheduled', 'working'])).toBe('working');
    expect(aggregateSessionStatus(['scheduled', 'needs_input'])).toBe('needs_input');
  });

  it('a stale error still outranks a scheduled terminal', () => {
    expect(aggregateSessionStatus(['scheduled', 'error'])).toBe('error');
  });
});
