import { describe, it, expect } from 'vitest';
import { collect, emptyState } from '../../../plugins/coach/lib/signals.mjs';
import { detect } from '../../../plugins/coach/lib/detectors.mjs';
import { DEFAULT_SETTINGS } from '../../../plugins/coach/lib/settings.mjs';
import { confirmPrompt } from '../../../plugins/coach/lib/prompts.mjs';
import { emptyMemory } from '../../../plugins/coach/lib/memory.mjs';

// Coach fix T3: a one-word go-ahead or a check-in is normal, never content to coach on.
const T0 = Date.parse('2026-11-05T09:00:00Z');
const at = (min: number, sec = 0) => new Date(T0 + min * 60_000 + sec * 1000).toISOString();
const prompt = (t: string, min: number, text: string) => ({ type: 'thread:prompt', terminalId: t, sessionId: 's1', at: at(min), source: 'user', text });
const turn = (t: string, endMin: number, ms: number) => ({ type: 'thread:turn', terminalId: t, sessionId: 's1', at: at(endMin), ms, outcome: 'done' });
const fold = (events: Record<string, unknown>[]) => events.reduce((s, e) => collect(e, s, DEFAULT_SETTINGS), emptyState());
const types = (events: Record<string, unknown>[], nowMin: number) => detect(fold(events), DEFAULT_SETTINGS, new Date(T0 + nowMin * 60_000)).map((c) => c.type);

describe('Coach: short go-aheads and check-ins are not content (coach fix T3)', () => {
  it('marks go-aheads ok', () => {
    for (const text of ['proceed', 'continue', 'go', 'go ahead', 'yes do it', 'yes proceed', 'yes push', 'push it', 'merge it', 'ship it', 'cut a release', 'cut the release', 'release it', 'next', 'keep going', 'carry on', 'sure', 'thanks', 'k', 'y', 'Proceed.']) {
      expect(fold([prompt('a', 0, text)]).prompts[0].ok, text).toBe(true);
    }
  });
  it('marks a reply of 3 words or 15 characters short', () => {
    expect(fold([prompt('a', 0, 'status?')]).prompts[0].short).toBe(true);
    expect(fold([prompt('a', 0, 'what about the tests')]).prompts[0].short).toBe(false);
  });
  it('repeated-prompt ignores go-aheads and short replies', () => {
    const ev = [0, 1, 2, 3].flatMap((d) => [prompt(`t${d}`, d * 60, 'proceed'), prompt(`u${d}`, d * 60 + 1, 'status?')]);
    expect(types(ev, 5 * 60)).not.toContain('repeated-prompt');
  });
  it('step-by-step counts only content prompts', () => {
    expect(types([0, 3, 6, 9, 12].map((m) => prompt('a', m, 'proceed')), 13)).not.toContain('step-by-step');
    expect(types([0, 3, 6, 9, 12].map((m) => prompt('a', m, 'status?')), 13)).not.toContain('step-by-step');
  });
  it('plugin-fit skips short prompts', () => {
    const run = (t: string, base: number) => ['go', 'next', 'proceed', 'status?'].map((x, i) => prompt(t, base + i, x));
    expect(types([...run('a', 0), ...run('b', 100), ...run('c', 200)], 300)).not.toContain('plugin-fit');
  });
  it('fast-approve carries no excerpt of the go-ahead', () => {
    const fast = [prompt('a', 0, 'refactor the billing module'), turn('a', 5, 300_000), { ...prompt('a', 5, 'looks good, ship it'), at: at(5, 6) }];
    const c = detect(fold(fast), DEFAULT_SETTINGS, new Date(T0 + 6 * 60_000)).find((x) => x.type === 'fast-approve')!;
    expect(c).toBeTruthy();
    expect(c.evidence.excerpt).toBeUndefined();
  });
  it('confirmPrompt leaves out a short or go-ahead excerpt', () => {
    const c = { id: 'x:1', type: 'step-by-step', measure: 'ambition', tip: 'prompt', evidence: { prompts: 5, excerpt: 'proceed' } };
    expect(JSON.stringify(confirmPrompt(c, emptyMemory()))).not.toContain('What they wrote');
    const c2 = { ...c, evidence: { prompts: 5, excerpt: 'Summarize the pipeline report for the team' } };
    expect(JSON.stringify(confirmPrompt(c2, emptyMemory()))).toContain('What they wrote');
  });
});
