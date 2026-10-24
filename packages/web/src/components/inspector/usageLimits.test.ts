import { describe, it, expect } from 'vitest';
import { limitRows, windowLabel } from './usageLimits';

const Z = 'America/Indianapolis';
const at = (iso: string) => Date.parse(iso);
const NOW = at('2026-10-24T12:40:00Z'); // 8:40 AM in Indianapolis (EDT)

describe('limitRows', () => {
  it('shows session, weekly and as-of; Opus only when reported', () => {
    const r = limitRows({ provider: 'claude-code', supported: true, paused: null, snapshot: {
      asOf: NOW, session: { usedPercent: 62, resetsAt: at('2026-10-24T17:10:00Z') }, weekly: { usedPercent: 24, resetsAt: at('2026-10-29T19:41:00Z') } } }, NOW, Z);
    expect(r.rows).toEqual([
      { label: 'Session (5h)', value: '62% used, resets 1:10 PM' },
      { label: 'Weekly', value: '24% used, resets Thu 3:41 PM' },
    ]);
    expect(r.asOf).toBe('As of 8:40 AM');
    expect(r.paused).toBeNull();
    const o = limitRows({ provider: 'claude-code', supported: true, paused: null, snapshot: { asOf: NOW, weeklyOpus: { usedPercent: 5, resetsAt: at('2026-10-29T19:41:00Z') } } }, NOW, Z);
    expect(o.rows[0].label).toBe('Weekly (Opus)');
  });
  it('shows the pause in the same words as the pause label', () => {
    const base = { provider: 'claude-code', supported: true, snapshot: null } as const;
    expect(limitRows({ ...base, paused: { kind: 'session', resetsAt: at('2026-10-24T17:10:00Z'), capped: false } }, NOW, Z).paused).toBe('Paused: session limit, resumes 1:10 PM');
    expect(limitRows({ ...base, paused: { kind: 'weekly', resetsAt: at('2026-10-29T19:41:00Z'), capped: false } }, NOW, Z).paused).toBe('Paused: weekly limit, resumes Thu 3:41 PM');
    expect(limitRows({ ...base, paused: { kind: 'session', resetsAt: null, capped: false } }, NOW, Z).paused).toBe('Paused: session limit, reset time unknown');
    expect(limitRows({ ...base, paused: { kind: 'session', resetsAt: 1, capped: true } }, NOW, Z).paused).toBe('Stopped: session limit, auto-resume gave up');
  });
  it('grok and opencode are Not reported; no figure yet says so', () => {
    expect(limitRows({ provider: 'grok', supported: false, snapshot: null, paused: null }, NOW, Z).rows).toEqual([{ label: 'Usage limits', value: 'Not reported' }]);
    expect(limitRows({ provider: 'claude-code', supported: true, snapshot: null, paused: null }, NOW, Z).rows[0].value).toBe('Not reported yet');
  });
});

describe('windowLabel', () => {
  it('no percent means below the warning level, not a made-up number', () => {
    expect(windowLabel({ usedPercent: null, resetsAt: at('2026-10-24T17:10:00Z') }, NOW, Z)).toBe('Under the warning level, resets 1:10 PM');
  });
  it('a window past its reset does not keep showing the old figure', () => {
    expect(windowLabel({ usedPercent: 98, resetsAt: at('2026-10-24T12:00:00Z') }, NOW, Z)).toBe('Reset 8:00 AM, no new figure yet');
  });
});
