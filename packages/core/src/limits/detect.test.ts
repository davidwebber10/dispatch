import { describe, it, expect } from 'vitest';
import { parseResetTime, detectClaudeLimit, detectCodexLimit, detectBannerLimit, pauseLabel } from './detect.js';

// 2026-10-24 04:31Z is 00:31 in Indianapolis (EDT, UTC-4): the Returns thread's real stop.
const NOW = Date.UTC(2026, 9, 24, 4, 31);
const ZONE = 'America/Indianapolis';
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe('parseResetTime', () => {
  it('reads a time and zone: "resets 1:10am (America/Indianapolis)"', () => {
    expect(iso(parseResetTime('resets 1:10am (America/Indianapolis)', NOW)?.at ?? null)).toBe('2026-10-24T05:10:00.000Z');
  });
  it('a time said at 11 PM rolls to the next day', () => {
    const lateNow = Date.UTC(2026, 9, 24, 3, 0); // 23:00 Oct 23 local
    expect(iso(parseResetTime('resets 1:10am (America/Indianapolis)', lateNow)?.at ?? null)).toBe('2026-10-24T05:10:00.000Z');
  });
  it('a time already past today means tomorrow', () => {
    const morning = Date.UTC(2026, 9, 24, 12, 0); // 08:00 local
    expect(iso(parseResetTime('resets 1:10am (America/Indianapolis)', morning)?.at ?? null)).toBe('2026-10-25T05:10:00.000Z');
  });
  it('reads an hour-only time: "resets 3pm"', () => {
    expect(iso(parseResetTime('resets 3pm (America/Indianapolis)', NOW)?.at ?? null)).toBe('2026-10-24T19:00:00.000Z');
  });
  it('reads a date: "resets Oct 30, 9am"', () => {
    expect(iso(parseResetTime('resets Oct 30, 9am (America/Indianapolis)', NOW)?.at ?? null)).toBe('2026-10-30T13:00:00.000Z');
  });
  it('reads a weekday: "resets Mon 9:00am" (next Monday)', () => {
    expect(iso(parseResetTime('resets Mon 9:00am (America/Indianapolis)', NOW)?.at ?? null)).toBe('2026-10-26T13:00:00.000Z');
  });
  it('reads "try again in 2 hours 5 minutes"', () => {
    expect(iso(parseResetTime('try again in 2 hours 5 minutes', NOW)?.at ?? null)).toBe('2026-10-24T06:36:00.000Z');
  });
  it('reads "try again at Oct 29th, 2026 9:00 AM"', () => {
    expect(parseResetTime('try again at Oct 29th, 2026 9:00 AM (America/Indianapolis)', NOW)?.at).toBe(Date.UTC(2026, 9, 29, 13, 0));
  });
  it('returns null when there is no time', () => {
    expect(parseResetTime('You have hit your limit', NOW)).toBeNull();
  });
});

const sessionText = "You've hit your session limit · resets 1:10am (America/Indianapolis)";

describe('detectClaudeLimit', () => {
  it('reads the real synthetic assistant frame: structured reset wins, kind from rateLimitType', () => {
    const frame = {
      type: 'assistant', apiError: 'usage_limit_reached', isApiErrorMessage: true,
      quotaLimits: { status: 'rejected', resetsAt: 1792818600, rateLimitType: 'five_hour' },
      message: { model: '<synthetic>', content: [{ type: 'text', text: sessionText }] },
    };
    const l = detectClaudeLimit(frame, NOW)!;
    expect(l.kind).toBe('session');
    expect(iso(l.resetsAt)).toBe('2026-10-24T05:10:00.000Z');
    expect(l.message).toBe(sessionText);
  });
  it('a weekly limit by rateLimitType seven_day', () => {
    const frame = { type: 'assistant', apiError: 'usage_limit_reached', quotaLimits: { resetsAt: 1793000000, rateLimitType: 'seven_day' },
      message: { content: [{ type: 'text', text: "You've hit your weekly limit · resets Oct 30, 9am (America/Indianapolis)" }] } };
    expect(detectClaudeLimit(frame, NOW)).toMatchObject({ kind: 'weekly', resetsAt: 1793000000 * 1000 });
  });
  it('an error result with the session text only: kind and time from the text', () => {
    const l = detectClaudeLimit({ type: 'result', subtype: 'success', is_error: true, result: sessionText }, NOW)!;
    expect(l.kind).toBe('session');
    expect(iso(l.resetsAt)).toBe('2026-10-24T05:10:00.000Z');
  });
  it('weekly and Opus-weekly texts are weekly', () => {
    expect(detectClaudeLimit({ type: 'result', is_error: true, result: "You've hit your weekly limit · resets Oct 30, 9am (America/Indianapolis)" }, NOW)?.kind).toBe('weekly');
    expect(detectClaudeLimit({ type: 'result', is_error: true, result: "You've hit your Opus weekly limit · resets Oct 30, 9am (America/Indianapolis)" }, NOW)?.kind).toBe('weekly');
  });
  it('a plain usage limit is kind usage; an unparsable time gives resetsAt null', () => {
    const l = detectClaudeLimit({ type: 'result', is_error: true, result: "You've hit your usage limit" }, NOW)!;
    expect(l).toMatchObject({ kind: 'usage', resetsAt: null });
  });
  it('a rejected rate_limit_event carries the reset', () => {
    const l = detectClaudeLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1792818600, rateLimitType: 'five_hour' } }, NOW)!;
    expect(l).toMatchObject({ kind: 'session', resetsAt: 1792818600 * 1000 });
  });
  it('a rejected rate_limit_event that is using overage, or has a fallback, is not a stop', () => {
    expect(detectClaudeLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1792818600, isUsingOverage: true } }, NOW)).toBeNull();
    expect(detectClaudeLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1792818600, unifiedRateLimitFallbackAvailable: true } }, NOW)).toBeNull();
  });
  it('an allowed rate_limit_event, a normal result, and ordinary prose are not limits', () => {
    expect(detectClaudeLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1792818600 } }, NOW)).toBeNull();
    expect(detectClaudeLimit({ type: 'result', is_error: false, result: 'Done.' }, NOW)).toBeNull();
    expect(detectClaudeLimit({ type: 'assistant', message: { content: [{ type: 'text', text: sessionText }] } }, NOW)).toBeNull();
    expect(detectClaudeLimit({ type: 'result', is_error: true, result: 'Tests failed' }, NOW)).toBeNull();
  });
});

describe('detectCodexLimit', () => {
  it('usageLimitExceeded with "try again in" text', () => {
    const l = detectCodexLimit({ message: "You've hit your usage limit. Try again in 2 hours 5 minutes.", codexErrorInfo: 'usageLimitExceeded' }, NOW)!;
    expect(l.kind).toBe('usage');
    expect(iso(l.resetsAt)).toBe('2026-10-24T06:36:00.000Z');
  });
  it('a weekly wording is weekly', () => {
    expect(detectCodexLimit({ message: "You've hit your weekly usage limit. Try again at Oct 29th, 2026 9:00 AM.", codexErrorInfo: 'usageLimitExceeded' }, NOW)?.kind).toBe('weekly');
  });
  it('rateLimitExceeded without a time parks with null reset', () => {
    expect(detectCodexLimit({ message: 'Rate limit reached', codexErrorInfo: 'rateLimitExceeded' }, NOW)).toMatchObject({ kind: 'usage', resetsAt: null });
  });
  it('another error is not a limit', () => {
    expect(detectCodexLimit({ message: 'context window exceeded', codexErrorInfo: 'contextWindowExceeded' }, NOW)).toBeNull();
    expect(detectCodexLimit({ message: 'boom' }, NOW)).toBeNull();
  });
});

describe('detectBannerLimit (CLI threads)', () => {
  it('finds the Claude banner through screen codes', () => {
    const out = `\x1b[31m  ⎿  You've hit your session limit · resets 1:10am (America/Indianapolis)\x1b[0m\r\n`;
    expect(detectBannerLimit(out, NOW)).toMatchObject({ kind: 'session' });
  });
  it('needs the exact shape: bare prose about a limit is ignored', () => {
    expect(detectBannerLimit('the user may hit their session limit someday', NOW)).toBeNull();
  });
});

describe('pauseLabel', () => {
  it('same-day time, kind named', () => {
    expect(pauseLabel('session', Date.UTC(2026, 9, 24, 5, 10), NOW, ZONE)).toBe('Paused: session limit, resumes 1:10 AM');
  });
  it('a later day shows the weekday', () => {
    expect(pauseLabel('weekly', Date.UTC(2026, 9, 26, 13, 0), NOW, ZONE)).toBe('Paused: weekly limit, resumes Mon 9:00 AM');
  });
  it('unknown reset names the fallback', () => {
    expect(pauseLabel('usage', null, NOW, ZONE, 30 * 60_000)).toBe('Paused: usage limit, reset time unknown, retrying in 30 minutes');
  });
});
