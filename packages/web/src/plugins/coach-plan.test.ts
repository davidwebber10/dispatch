import { describe, it, expect, vi } from 'vitest';
import { planCall, LARGE_DEFAULT, budgetFraction } from '../../../plugins/coach/lib/plan.mjs';
import { confirmPrompt, writePrompt, morePrompt, recapPrompt, parseAnswer, checkCard } from '../../../plugins/coach/lib/prompts.mjs';
import { judgeCandidate, budgetFromHeaders, joinCards } from '../../../plugins/coach/lib/judge.mjs';
import { makeAssist } from '../../../plugins/coach/lib/client.mjs';
import { withDefaults } from '../../../plugins/coach/lib/settings.mjs';
import { emptyMemory, confirmFact } from '../../../plugins/coach/lib/memory.mjs';

const FREE = { usedPercent: 0, capPercent: 3 };
const s = (over: Record<string, unknown> = {}) => withDefaults(over);
const tiers = (level: string, budget = FREE) => Object.fromEntries((['confirm', 'write', 'more', 'review-thread', 'review-prompt', 'recap'] as const).map((step) => [step, planCall(step, s({ thoroughness: level }), budget).tier]));

describe('Coach judge: planCall (coach plan Task 9)', () => {
  it('Economy: the small model confirms (and fills the card); the large model only for More and the recap', () => {
    expect(tiers('economy')).toEqual({ confirm: 'small', write: 'none', more: 'large', 'review-thread': 'none', 'review-prompt': 'none', recap: 'large' });
  });
  it('Balanced: as Economy, plus the large model writes each card and reviews each finished thread', () => {
    expect(tiers('balanced')).toEqual({ confirm: 'small', write: 'large', more: 'large', 'review-thread': 'large', 'review-prompt': 'none', recap: 'large' });
  });
  it('Thorough: the large model judges every candidate and every prompt', () => {
    expect(tiers('thorough')).toEqual({ confirm: 'large', write: 'large', more: 'large', 'review-thread': 'large', 'review-prompt': 'large', recap: 'large' });
  });
  it('Use my budget: the most thorough level that fits, stepping down at 80% and 90% of the cap', () => {
    expect(planCall('review-prompt', s({ thoroughness: 'budget' }), { usedPercent: 1, capPercent: 10 })).toMatchObject({ tier: 'large', level: 'thorough' });
    expect(planCall('review-prompt', s({ thoroughness: 'budget' }), { usedPercent: 8, capPercent: 10 })).toMatchObject({ tier: 'none', level: 'balanced', stepped: true });
    expect(planCall('write', s({ thoroughness: 'budget' }), { usedPercent: 9, capPercent: 10 })).toMatchObject({ tier: 'none', level: 'economy', stepped: true });
  });
  it('every level steps down near the cap: Balanced at 80% stops writing; Economy at 90% is rules only', () => {
    expect(planCall('write', s(), { usedPercent: 2.4, capPercent: 3 })).toMatchObject({ tier: 'none', level: 'economy', stepped: true });
    expect(planCall('confirm', s({ thoroughness: 'economy' }), { usedPercent: 2.5, capPercent: 3 })).toMatchObject({ tier: 'small', level: 'small-only' });
    expect(planCall('more', s({ thoroughness: 'economy' }), { usedPercent: 2.5, capPercent: 3 }).tier).toBe('none');
    expect(planCall('confirm', s({ thoroughness: 'economy' }), { usedPercent: 2.8, capPercent: 3 }).tier).toBe('none');
  });
  it('none at the cap, at any level', () => {
    for (const level of ['economy', 'balanced', 'thorough', 'budget']) {
      for (const step of ['confirm', 'write', 'more', 'recap'] as const) expect(planCall(step, s({ thoroughness: level }), { usedPercent: 3, capPercent: 3 }).tier).toBe('none');
    }
  });
  it('an unknown budget (no headers yet) is no step-down', () => {
    expect(planCall('write', s(), { usedPercent: null, capPercent: null }).tier).toBe('large');
  });
  it('Automatic: the small tier runs where the most room is; the large tier runs on the harness the small one used, with its large model', () => {
    expect(planCall('confirm', s(), FREE)).toMatchObject({ harness: 'auto', model: undefined });
    expect(planCall('write', s(), FREE, { harness: 'codex' })).toMatchObject({ harness: 'codex', model: LARGE_DEFAULT.codex });
    expect(planCall('write', s(), FREE)).toMatchObject({ harness: 'claude', model: LARGE_DEFAULT.claude });
  });
  it('a picked harness and model per tier are used as they are', () => {
    const picked = s({ model: { mode: 'pick', small: { harness: 'codex', model: 'gpt-6.1-terra' }, large: { harness: 'openrouter', model: 'anthropic/claude-opus-5.5' } } });
    expect(planCall('confirm', picked, FREE)).toMatchObject({ tier: 'small', harness: 'codex', model: 'gpt-6.1-terra' });
    expect(planCall('more', picked, FREE)).toMatchObject({ tier: 'large', harness: 'openrouter', model: 'anthropic/claude-opus-5.5' });
  });
  it('OpenRouter budgets are dollars: the step-down reads usedUsd over capUsd', () => {
    expect(planCall('write', s(), { usedUsd: 4.6, capUsd: 5 }).tier).toBe('none');
    expect(planCall('confirm', s(), { usedUsd: 5, capUsd: 5 }).tier).toBe('none');
  });
});

const CAND = { id: 'idle-wait:t1:x', type: 'idle-wait', measure: 'delegation', tip: 'thinkBigger', terminalId: 't1', projectId: 's1', evidence: { minutes: 6 }, at: '2026-11-20T10:00:00.000Z' };
const PROMPT_CAND = { id: 'no-plan-big-task:t1:y', type: 'no-plan-big-task', measure: 'judgment', tip: 'prompt', terminalId: 't1', projectId: 's1', evidence: { parts: 4, chars: 620, excerpt: 'Pull last week returns by reason, chart them, compare with the prior month and email Sam.' }, at: '2026-11-20T10:00:00.000Z' };
const GOOD = { fit: true, confidence: 0.9, headline: 'Start a second thread while this runs', why: 'You waited 6 minutes with nothing else running.', action: { kind: 'compose', label: 'Try it: draft the next task', text: 'In a new thread: draft the release note.' } };
const answer = (v: unknown, budget = FREE) => ({ result: { text: typeof v === 'string' ? v : JSON.stringify(v), harness: 'claude' }, budget, refused: null });

describe('Coach judge: the prompts and the answers (coach plan Task 9)', () => {
  const mem = confirmFact(emptyMemory(), { id: 'f1', text: 'Not a developer: finance project', source: 'Your feedback', at: '2026-11-01T00:00:00Z', confirmedAt: null });
  it('memory facts are in every prompt; the fixed instructions come first, in the system text', () => {
    const memory = { ...mem, known: ['repeated-prompt'], levelAdjust: { judgment: 1 } };
    const all = [confirmPrompt(CAND, memory), writePrompt(CAND, memory, GOOD), morePrompt({ ...GOOD, ...CAND }, memory), recapPrompt({ patterns: ['p'], stretch: null }, memory)];
    for (const p of all) {
      const text = p.messages.map((m: { content: string }) => m.content).join('\n');
      expect(text).toContain('Not a developer: finance project');
      expect(text).toContain('Repeated prompts');
      expect(typeof p.system).toBe('string');
      expect(p.system.length).toBeGreaterThan(200);
      expect(p.maxTokens).toBeGreaterThan(0);
    }
    // The same fixed text for every confirm call, so the provider's prompt cache can reuse it.
    expect(confirmPrompt(CAND, memory).system).toBe(confirmPrompt(PROMPT_CAND, emptyMemory()).system);
  });
  it('a proposed fact the person did not confirm is not in the prompt', () => {
    const memory = { ...emptyMemory(), facts: [{ id: 'f2', text: 'UNCONFIRMED', source: 'x', at: '2026-11-01T00:00:00Z', confirmedAt: null }] };
    expect(JSON.stringify(confirmPrompt(CAND, memory))).not.toContain('UNCONFIRMED');
  });
  it('parseAnswer reads the JSON object in the text, or gives null', () => {
    expect(parseAnswer('Here: {"fit": true, "confidence": 0.8}')).toEqual({ fit: true, confidence: 0.8 });
    expect(parseAnswer('')).toBeNull();
    expect(parseAnswer('{"fit": tru')).toBeNull();
    expect(parseAnswer('[1,2]')).toBeNull();
  });
  it('checkCard enforces the card copy: a headline of at most 8 words, a why line, an action, no "should"', () => {
    expect(checkCard(GOOD, 0.7)).toBe(null);
    expect(checkCard({ ...GOOD, headline: 'You should start a second thread now please' }, 0.7)).toBe('copy');
    expect(checkCard({ ...GOOD, headline: 'Start a second thread while this one runs for you' }, 0.7)).toBe('copy');
    expect(checkCard({ ...GOOD, why: '' }, 0.7)).toBe('malformed');
    expect(checkCard({ ...GOOD, action: null }, 0.7)).toBe('malformed');
    expect(checkCard({ ...GOOD, confidence: 0.5 }, 0.7)).toBe('unsure');
    expect(checkCard({ ...GOOD, fit: false }, 0.7)).toBe('no-fit');
  });
});

describe('Coach judge: one candidate (coach plan Task 9)', () => {
  const now = new Date('2026-11-20T10:01:00Z');
  it('Balanced: the small model confirms, the large model writes; the card joins the candidate and the answer', async () => {
    const assist = vi.fn()
      .mockResolvedValueOnce(answer(GOOD))
      .mockResolvedValueOnce(answer({ ...GOOD, headline: 'Run a second thread while you wait' }));
    const r = await judgeCandidate(PROMPT_CAND, { settings: s(), memory: emptyMemory(), budget: FREE, assist, now });
    expect(assist).toHaveBeenCalledTimes(2);
    expect(assist.mock.calls[0][0]).toMatchObject({ harness: 'auto' });
    expect(assist.mock.calls[1][0]).toMatchObject({ harness: 'claude', model: LARGE_DEFAULT.claude });
    expect(r.outcome).toBe('card');
    expect(r.card).toMatchObject({ id: PROMPT_CAND.id, type: 'no-plan-big-task', measure: 'judgment', terminalId: 't1', projectId: 's1', headline: 'Run a second thread while you wait', why: GOOD.why, action: GOOD.action, excerpt: PROMPT_CAND.evidence.excerpt });
    expect(typeof r.card!.reason).toBe('string');
    expect(r.calls.map((c: { step: string; ok: boolean }) => [c.step, c.ok])).toEqual([['confirm', true], ['write', true]]);
  });
  it('Economy: one small call fills the card', async () => {
    const assist = vi.fn().mockResolvedValueOnce(answer(GOOD));
    const r = await judgeCandidate(CAND, { settings: s({ thoroughness: 'economy' }), memory: emptyMemory(), budget: FREE, assist, now });
    expect(assist).toHaveBeenCalledTimes(1);
    expect(r.card).toMatchObject({ headline: GOOD.headline });
  });
  it('a malformed or empty answer drops the candidate and records the call', async () => {
    for (const bad of ['', 'not json at all', '{"fit": true, "confidence": 0.9, "headline": "", "why": "x"}']) {
      const assist = vi.fn().mockResolvedValueOnce(answer(bad));
      const r = await judgeCandidate(CAND, { settings: s(), memory: emptyMemory(), budget: FREE, assist, now });
      expect(r.card).toBeNull();
      expect(r.outcome).toBe('dropped');
      expect(r.calls).toEqual([expect.objectContaining({ step: 'confirm', tier: 'small', ok: false })]);
    }
    const none = vi.fn().mockResolvedValueOnce({ result: null, budget: FREE, refused: null });
    const r = await judgeCandidate(CAND, { settings: s(), memory: emptyMemory(), budget: FREE, assist: none, now });
    expect(r).toMatchObject({ card: null, outcome: 'dropped', calls: [expect.objectContaining({ ok: false })] });
  });
  it('a malformed write keeps the small model\'s confirmed card whole, never a half-filled one', async () => {
    const assist = vi.fn().mockResolvedValueOnce(answer(GOOD)).mockResolvedValueOnce(answer('{"headline": "Half'));
    const r = await judgeCandidate(CAND, { settings: s(), memory: emptyMemory(), budget: FREE, assist, now });
    expect(r.card).toMatchObject({ headline: GOOD.headline, why: GOOD.why, action: GOOD.action });
    expect(r.calls.map((c: { ok: boolean }) => c.ok)).toEqual([true, false]);
  });
  it('a low-confidence answer is dropped; minConfidence is a setting', async () => {
    const assist = vi.fn().mockResolvedValue(answer({ ...GOOD, confidence: 0.6 }));
    expect((await judgeCandidate(CAND, { settings: s(), memory: emptyMemory(), budget: FREE, assist, now })).outcome).toBe('dropped');
    const r = await judgeCandidate(CAND, { settings: s({ thoroughness: 'economy', advanced: { minConfidence: 0.5 } }), memory: emptyMemory(), budget: FREE, assist, now });
    expect(r.outcome).toBe('card');
  });
  it('a refusal for the budget stops the judge and keeps the candidate for later; the new budget comes back', async () => {
    const assist = vi.fn().mockResolvedValueOnce({ result: null, budget: { usedPercent: 3.1, capPercent: 3 }, refused: { error: 'budget' } });
    const r = await judgeCandidate(CAND, { settings: s(), memory: emptyMemory(), budget: FREE, assist, now });
    expect(r).toMatchObject({ card: null, outcome: 'budget', budget: { usedPercent: 3.1, capPercent: 3 } });
  });
  it('at the cap no call is made', async () => {
    const assist = vi.fn();
    const r = await judgeCandidate(CAND, { settings: s(), memory: emptyMemory(), budget: { usedPercent: 3, capPercent: 3 }, assist, now });
    expect(assist).not.toHaveBeenCalled();
    expect(r.outcome).toBe('budget');
  });
});

describe('Coach judge: the budget headers and the cards document (coach plan Task 9)', () => {
  it('budgetFromHeaders reads the percent headers, or the dollar ones on OpenRouter', () => {
    expect(budgetFromHeaders(new Headers({ 'X-Budget-Used-Percent': '1.25', 'X-Budget-Cap-Percent': '3' }))).toEqual({ usedPercent: 1.25, capPercent: 3 });
    expect(budgetFromHeaders(new Headers({ 'X-Budget-Used-Usd': '0.4', 'X-Budget-Cap-Usd': '5' }))).toEqual({ usedUsd: 0.4, capUsd: 5 });
    expect(budgetFromHeaders(new Headers())).toBeNull();
    // The daemon's fail-safe token cap (no usage figures): the tokens count, and the plan steps down on them.
    const tok = budgetFromHeaders(new Headers({ 'X-Budget-Cap-Percent': '3', 'X-Budget-Used-Tokens': '149000', 'X-Budget-Cap-Tokens': '150000' }));
    expect(tok).toMatchObject({ usedTokens: 149000, capTokens: 150000 });
    expect(budgetFraction(tok)).toBeCloseTo(149000 / 150000);
  });
  it('makeAssist posts to the plugin route with the key, and reads the budget headers; a 429 budget is a refusal', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: '{}', harness: 'codex' }), { status: 200, headers: { 'X-Budget-Used-Percent': '0.5', 'X-Budget-Cap-Percent': '3' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'budget', usedPercent: 3.2, capPercent: 3 }), { status: 429, headers: { 'X-Budget-Used-Percent': '3.2', 'X-Budget-Cap-Percent': '3' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'no_answer' }), { status: 502 }));
    const assist = makeAssist({ fetch, api: 'http://x', plugin: 'coach', key: () => 'k1' });
    const a = await assist({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 10, harness: 'auto' });
    expect(fetch.mock.calls[0][0]).toBe('http://x/api/plugins/coach/assist');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer k1');
    expect(a).toMatchObject({ result: { harness: 'codex' }, budget: { usedPercent: 0.5, capPercent: 3 }, refused: null });
    const b = await assist({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 });
    expect(b).toMatchObject({ result: null, budget: { usedPercent: 3.2, capPercent: 3 }, refused: { error: 'budget' } });
    const c = await assist({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 });
    expect(c).toMatchObject({ result: null, refused: null });
  });
  it('joinCards adds new cards (newest last, capped) and records each judged candidate once', () => {
    const doc = joinCards(null, [{ id: 'a', outcome: 'card', card: { id: 'a', headline: 'h' }, calls: [{ step: 'confirm', tier: 'small', ok: true }] }, { id: 'b', outcome: 'dropped', card: null, calls: [{ step: 'confirm', tier: 'small', ok: false }] }], '2026-11-20T10:00:00Z');
    expect(doc.items.map((c: { id: string }) => c.id)).toEqual(['a']);
    expect(doc.judged).toEqual([
      { id: 'a', at: '2026-11-20T10:00:00Z', outcome: 'card', calls: 1 },
      { id: 'b', at: '2026-11-20T10:00:00Z', outcome: 'dropped', calls: 1 },
    ]);
    // A candidate the budget stopped is not recorded: it is judged later.
    const next = joinCards(doc, [{ id: 'c', outcome: 'budget', card: null, calls: [] }], '2026-11-20T11:00:00Z');
    expect(next.judged.map((j: { id: string }) => j.id)).toEqual(['a', 'b']);
  });
});
