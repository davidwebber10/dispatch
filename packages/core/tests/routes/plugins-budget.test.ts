import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as pluginData from '../../src/db/plugin-data.js';
import { WEEKLY_TOKENS_PER_PERCENT } from '../../src/plugins/assist-share.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import { LimitSnapshots } from '../../src/limits/snapshot.js';
import type { UsageSummary } from '../../src/limits/gauge.js';
import type { AssistRunner, AssistRequest, AssistResult } from '../../src/assist/run.js';
import { KeysManager } from './keys-manager.js';

/** A per-plugin model budget the daemon enforces (coach plan, Task 4; coach spec sections 4.5, 7.4, 9a.2). */
describe('plugin budget (coach plan, Task 4)', () => {
  let app: any; let db: Database.Database; let tmp: string; let calls: AssistRequest[];
  let summary: UsageSummary | null;
  const now = Date.now();
  const plugin = (id: string, permissions: string[]) => {
    const dir = path.join(tmp, 'plugins', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', permissions }));
  };
  const asPlugin = (id: string) => ({ Authorization: `Bearer ${fs.readFileSync(path.join(tmp, 'keys', `plugin-${id}`), 'utf8').trim()}` });
  // Each answer: Opus, 400 output tokens, on the Claude `cli` account.
  const answer = (req: AssistRequest): AssistResult => ({ text: 'ok', usage: { inputTokens: 0, outputTokens: 400, cacheReadTokens: 0, cacheCreateTokens: 0 }, ms: 1, model: req.model ?? 'claude-opus-5', harness: req.harness === 'openrouter' ? 'openrouter' : req.harness === 'codex' ? 'codex' : 'claude', accountId: req.harness === 'openrouter' ? null : 'cli', costUsd: req.harness === 'openrouter' ? 0.5 : null });
  const runner: AssistRunner = { available: async () => true, run: async (req) => { calls.push(req); return answer(req); } };
  const build = (r: AssistRunner) => {
    const mgr = new KeysManager();
    return createApp({ db, skipPty: true, pluginsDir: path.join(tmp, 'plugins'), secretsDir: tmp, managers: new Map([['claude-code', mgr.asManager()]]), assistRunner: r,
      usageLimits: { snapshots: new LimitSnapshots(db), accountFor: () => 'acct', summary: () => summary as UsageSummary } });
  };
  const limits = (fiveHour: number, sevenDay: number): UsageSummary => ({
    type: 'usage-limits', at: now, epoch: 'e', rev: 1, warnPercent: 80, pushOnWarn: false, paused: [],
    providers: [{ provider: 'claude-code', accountId: 'cli', label: 'cli', asOf: now, windows: { five_hour: { usedPercent: fiveHour, resetsAt: now + 3_600_000 }, seven_day: { usedPercent: sevenDay, resetsAt: now + 3 * 86_400_000 } } }],
  });
  /** Thread turns and plugin calls on `cli` this week: Opus output only, so weight is proportional to tokens. */
  const usage = (threadOut: number, pluginOut: number) => {
    db.prepare('INSERT INTO usage_turns (id, terminal_id, project_id, provider, model, started_at, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`u${Math.random()}`, 'tX', 'A', 'claude-code', 'claude-opus-5', new Date(now - 3_600_000).toISOString(), threadOut);
    if (pluginOut) pluginData.recordAssist(db, 'coach', { at: new Date(now - 3_600_000).toISOString(), model: 'claude-opus-5', harness: 'claude', accountId: 'cli', inputTokens: 0, outputTokens: pluginOut, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: null, ms: 1, ok: true });
  };
  const ask = (extra: Record<string, unknown> = {}) => request(app).post('/api/plugins/coach/assist').set(asPlugin('coach')).send({ messages: [{ role: 'user', content: 'x' }], harness: 'claude', model: 'claude-opus-5', maxTokens: 400, ...extra });

  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-budget-'));
    db = new Database(':memory:'); initSchema(db);
    calls = [];
    summary = limits(10, 10);
    plugin('coach', ['model:assist']);
    app = build(runner);
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'Alpha', workingDir: tmp });
    terminalsDb.create(db, { id: 'tX', sessionId: 'A', type: 'claude-code', label: 'Worker', config: {} });
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('the owner reads and sets the budget; a plugin key cannot; bad values are 400', async () => {
    expect((await request(app).get('/api/plugins/coach/budget')).body).toEqual({ percentWeekly: null, usdWeekly: null });
    const put = await request(app).put('/api/plugins/coach/budget').send({ percentWeekly: 3, usdWeekly: 5 });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ percentWeekly: 3, usdWeekly: 5 });
    expect((await request(app).get('/api/plugins/coach/budget')).body).toEqual({ percentWeekly: 3, usdWeekly: 5 });
    expect((await request(app).put('/api/plugins/coach/budget').set(asPlugin('coach')).send({ percentWeekly: 100 })).status).toBe(403);
    expect((await request(app).put('/api/plugins/coach/budget').send({ percentWeekly: 0.05 })).status).toBe(400);
    expect((await request(app).put('/api/plugins/coach/budget').send({ percentWeekly: 101 })).status).toBe(400);
    expect((await request(app).put('/api/plugins/coach/budget').send({ usdWeekly: -1 })).status).toBe(400);
    // null clears one; the other stays.
    expect((await request(app).put('/api/plugins/coach/budget').send({ percentWeekly: null })).body).toEqual({ percentWeekly: null, usdWeekly: 5 });
    expect((await request(app).put('/api/plugins/nope/budget').send({ percentWeekly: 3 })).status).toBe(404);
  });

  it('assist is refused with 429 budget at the cap', async () => {
    await request(app).put('/api/plugins/coach/budget').send({ percentWeekly: 3 });
    usage(7000, 3000); // the plugin holds 30% of the account's Dispatch weight: 3% of the 10% used.
    const r = await ask();
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: 'budget', capPercent: 3 });
    expect(r.body.usedPercent).toBeCloseTo(3, 6);
    expect(calls).toHaveLength(0);
  });

  it('under the cap the answer carries the budget headers', async () => {
    await request(app).put('/api/plugins/coach/budget').send({ percentWeekly: 3 });
    usage(9000, 1000); // 1% of the week
    const r = await ask();
    expect(r.status).toBe(200);
    expect(Number(r.headers['x-budget-used-percent'])).toBeCloseTo(1, 3);
    expect(r.headers['x-budget-cap-percent']).toBe('3');
  });

  it('the 5-hour floor refuses at 90%', async () => {
    await request(app).put('/api/plugins/coach/budget').send({ percentWeekly: 50 });
    summary = limits(90, 10);
    const r = await ask();
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: 'budget', window: 'five_hour', usedPercent: 90, capPercent: 90 });
    summary = limits(89.9, 10);
    expect((await ask()).status).toBe(200);
  });

  it('openrouter uses the dollar budget', async () => {
    await request(app).put('/api/plugins/coach/budget').send({ percentWeekly: 3, usdWeekly: 1 });
    // The account's percent budget does not apply to OpenRouter, even with the Claude week full.
    summary = limits(99, 99);
    const first = await ask({ harness: 'openrouter', model: 'openai/gpt-x' });
    expect(first.status).toBe(200);
    expect(first.headers['x-budget-cap-usd']).toBe('1');
    expect((await ask({ harness: 'openrouter', model: 'openai/gpt-x' })).status).toBe(200);
    // $1.00 spent of $1.00: refused.
    const third = await ask({ harness: 'openrouter', model: 'openai/gpt-x' });
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ error: 'budget', usedUsd: 1, capUsd: 1 });
  });

  it('no budget set means no cap', async () => {
    summary = limits(99, 99);
    usage(1000, 9000);
    const r = await ask();
    expect(r.status).toBe(200);
    expect(r.headers['x-budget-cap-percent']).toBeUndefined();
  });

  it('three concurrent calls at 2.9% of a 3% cap: at most the calls already in flight finish; the next is refused', async () => {
    await request(app).put('/api/plugins/coach/budget').send({ percentWeekly: 3 });
    usage(7100, 2900); // 2.9% of the week
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    app = build({ available: async () => true, run: async (req) => { calls.push(req); await gate; return answer(req); } });
    // supertest sends lazily: `.then` starts each request now.
    const three = [1, 2, 3].map(() => ask().then((r) => r));
    await new Promise((r) => setTimeout(r, 80));
    release();
    const statuses = (await Promise.all(three)).map((r) => r.status).sort();
    // The first is in flight with its reservation (400 Opus output tokens); the others see 2.9% + the reservation.
    expect(statuses).toEqual([200, 429, 429]);
    expect(calls).toHaveLength(1);
    // The finished call is metered: the next one is refused.
    expect((await ask()).status).toBe(429);
  });

  it('auto checks the budget of the account it picks', async () => {
    await request(app).put('/api/plugins/coach/budget').send({ percentWeekly: 3 });
    usage(7000, 3000);
    app = build({ ...runner, pick: async () => ({ harness: 'claude', accountId: 'cli', reason: 'test' }) });
    const r = await ask({ harness: 'auto' });
    expect(r.status).toBe(429);
    expect(calls).toHaveLength(0);
  });
  it('an accountId the daemon does not know is 400, and no model runs (it cannot skip the budget)', async () => {
    await request(app).put('/api/plugins/coach/budget').send({ percentWeekly: 3 });
    usage(7000, 3000); // at the cap on `cli`
    const r = await ask({ accountId: 'ghost' });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'unknown_account' });
    expect(calls).toHaveLength(0);
    // The known default account is still accepted (and refused at its cap).
    expect((await ask({ accountId: 'cli' })).status).toBe(429);
  });

  it('the meter row records the account that actually ran, even when the answer does not name it', async () => {
    app = build({ available: async () => true, run: async (req) => { calls.push(req); return { ...answer(req), accountId: null }; } });
    const r = await ask();
    expect(r.status).toBe(200);
    // The runner ran on the default account: the request carried it, and the meter row names it.
    expect(calls[0].accountId).toBe('cli');
    const row = db.prepare('SELECT account_id AS a FROM plugin_assist WHERE plugin_id = ?').get('coach') as { a: string | null };
    expect(row.a).toBe('cli');
  });
  it('the share route needs read:usage for a plugin key; the owner may always read it', async () => {
    const r = await request(app).get('/api/plugins/coach/assist/share').set(asPlugin('coach'));
    expect(r.status).toBe(403);
    expect((await request(app).get('/api/plugins/coach/assist/share')).status).toBe(200);
    plugin('reader', ['model:assist', 'read:usage']);
    app = build(runner);
    expect((await request(app).get('/api/plugins/reader/assist/share').set(asPlugin('reader'))).status).toBe(200);
  });
  it('with no usage window for the account, calls stop at the weekly token fallback (fail safe)', async () => {
    await request(app).put('/api/plugins/coach/budget').send({ percentWeekly: 3 });
    summary = null; // no usage data at all: the share is unknown
    const cap = 3 * WEEKLY_TOKENS_PER_PERCENT;
    pluginData.recordAssist(db, 'coach', { at: new Date(now - 86_400_000).toISOString(), model: 'claude-haiku-4-5', harness: 'claude', accountId: 'cli', inputTokens: cap - 300, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: null, ms: 1, ok: true });
    const under = await request(app).post('/api/plugins/coach/assist').set(asPlugin('coach')).send({ messages: [{ role: 'user', content: 'x' }], harness: 'claude', maxTokens: 100 });
    expect(under.status).toBe(200);
    expect(under.headers['x-budget-cap-tokens']).toBe(String(cap));
    // The answer's 400 output tokens pass the cap: the next call is refused, and no model runs.
    const n = calls.length;
    const r = await ask();
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: 'budget', window: 'unknown', capTokens: cap });
    expect(calls).toHaveLength(n);
  });
  it('an OpenRouter answer with no cost and an unknown model is metered at a conservative estimate, so the dollar cap still fills', async () => {
    await request(app).put('/api/plugins/coach/budget').send({ usdWeekly: 0.05 });
    app = build({ available: async () => true, run: async (req) => { calls.push(req); return { ...answer(req), model: 'mystery/model-x', costUsd: null, usage: { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheCreateTokens: 0 } }; } });
    expect((await ask({ harness: 'openrouter', model: 'mystery/model-x' })).status).toBe(200);
    const row = db.prepare('SELECT cost_usd AS c, cost_estimated AS e FROM plugin_assist WHERE plugin_id = ?').get('coach') as { c: number | null; e: number };
    // 1000 in at $15/M and 1000 out at $75/M.
    expect(row.c).toBeCloseTo(0.09, 6);
    expect(row.e).toBe(1);
    const r = await ask({ harness: 'openrouter', model: 'mystery/model-x' });
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: 'budget', capUsd: 0.05 });
  });
});
