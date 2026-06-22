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
});
