import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import type { AssistRunner, AssistRequest, AssistResult } from '../../src/assist/run.js';
import * as pluginData from '../../src/db/plugin-data.js';
import { KeysManager } from './keys-manager.js';
import { LimitSnapshots } from '../../src/limits/snapshot.js';
import type { UsageSummary } from '../../src/limits/gauge.js';

/** Model assist for plugins (docs/superpowers/specs/2026-11-07-plugins-design.md, section 3.4). */
describe('plugin assist route (2026-11-07)', () => {
  let app: any; let db: Database.Database; let tmp: string; let calls: AssistRequest[];
  const plugin = (id: string, permissions: string[]) => {
    const dir = path.join(tmp, 'plugins', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', permissions }));
  };
  const asPlugin = (id: string) => ({ Authorization: `Bearer ${fs.readFileSync(path.join(tmp, 'keys', `plugin-${id}`), 'utf8').trim()}` });
  const fakeRunner: AssistRunner = {
    available: async () => true,
    run: async (req) => { calls.push(req); return { text: `judged: ${req.messages[0]?.content ?? ''}`, usage: { inputTokens: 120, outputTokens: 30 }, ms: 250, model: 'fake-model' } as AssistResult; },
  };
  let summary: UsageSummary | null = null;
  const build = (runner: AssistRunner | null) => {
    const mgr = new KeysManager();
    return createApp({ db, skipPty: true, pluginsDir: path.join(tmp, 'plugins'), secretsDir: tmp, managers: new Map([['claude-code', mgr.asManager()]]), assistRunner: runner,
      usageLimits: { snapshots: new LimitSnapshots(db), accountFor: () => 'acct', summary: () => summary as UsageSummary },
      // `work` is an added account on both harnesses; `cli` is the default.
      assistAccounts: { has: (_p, id) => id === 'cli' || id === 'work', defaultId: () => 'cli' } });
  };

  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-assist-'));
    db = new Database(':memory:'); initSchema(db);
    calls = [];
    summary = null;
    plugin('coach', ['model:assist']);
    plugin('mute', []);
    app = build(fakeRunner);
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'Alpha', workingDir: tmp });
    terminalsDb.create(db, { id: 'tX', sessionId: 'A', type: 'claude-code', label: 'Worker', config: { transport: 'structured', role: 'agent' } });
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('a thread key cannot drive assist (403), and a fourth call in flight for one plugin gets 429', async () => {
    const body = { messages: [{ role: 'user', content: 'x' }] };
    const thread = { Authorization: `Bearer ${app.locals.keys.mint({ kind: 'thread', terminalId: 'tX' }).key}` };
    expect((await request(app).post('/api/plugins/coach/assist').set(thread).send(body)).status).toBe(403);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const slow: AssistRunner = { available: async () => true, run: async () => { await gate; return { text: 'late', usage: { inputTokens: 1, outputTokens: 1 }, ms: 1, model: 'm' } as AssistResult; } };
    app = build(slow);
    // supertest sends lazily: `.then` starts each request now, so three are in flight before the fourth.
    const inflight = [1, 2, 3].map(() => request(app).post('/api/plugins/coach/assist').set(asPlugin('coach')).send(body).then((r) => r));
    await new Promise((r) => setTimeout(r, 80));
    const fourth = await request(app).post('/api/plugins/coach/assist').set(asPlugin('coach')).send(body);
    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toBe('busy');
    release();
    expect((await Promise.all(inflight)).map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await request(app).post('/api/plugins/coach/assist').set(asPlugin('coach')).send(body)).status).toBe(200);
  });

  it('a plugin with model:assist gets text and usage, and the call is metered on its row', async () => {
    const r = await request(app).post('/api/plugins/coach/assist').set(asPlugin('coach')).send({ system: 'You judge prompts.', messages: [{ role: 'user', content: 'Fix the bug' }], maxTokens: 300 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ text: 'judged: Fix the bug', usage: { inputTokens: 120, outputTokens: 30 }, ms: 250, model: 'fake-model' });
    expect(calls[0]).toMatchObject({ system: 'You judge prompts.', maxTokens: 300 });
    const row = (await request(app).get('/api/plugins')).body.plugins.find((p: any) => p.id === 'coach');
    expect(row.assist).toMatchObject({ calls: 1, inputTokens: 120, outputTokens: 30 });
  });

  it('without the permission the plugin gets 403 naming it; another plugin cannot assist as this one', async () => {
    const no = await request(app).post('/api/plugins/mute/assist').set(asPlugin('mute')).send({ messages: [{ role: 'user', content: 'x' }] });
    expect(no.status).toBe(403);
    expect(no.body.message).toContain('"model:assist"');
    const other = await request(app).post('/api/plugins/mute/assist').set(asPlugin('coach')).send({ messages: [{ role: 'user', content: 'x' }] });
    expect(other.status).toBe(403);
  });

  it('passes harness, model and account to the runner (coach plan, Task 1)', async () => {
    const r = await request(app).post('/api/plugins/coach/assist').set(asPlugin('coach')).send({ messages: [{ role: 'user', content: 'x' }], harness: 'codex', model: 'gpt-5.6-sol', accountId: 'work' });
    expect(r.status).toBe(200);
    expect(calls[0]).toMatchObject({ harness: 'codex', model: 'gpt-5.6-sol', accountId: 'work' });
    await request(app).post('/api/plugins/coach/assist').set(asPlugin('coach')).send({ messages: [{ role: 'user', content: 'x' }] });
    expect(calls[1].harness).toBeUndefined();
    expect(calls[1].model).toBeUndefined();
  });

  it('400 for an unknown harness or a model with spaces or over 120 chars', async () => {
    const send = (extra: Record<string, unknown>) => request(app).post('/api/plugins/coach/assist').set(asPlugin('coach')).send({ messages: [{ role: 'user', content: 'x' }], ...extra });
    expect((await send({ harness: 'gemini' })).status).toBe(400);
    expect((await send({ harness: 7 })).status).toBe(400);
    expect((await send({ model: 'claude opus' })).status).toBe(400);
    expect((await send({ model: 'm'.repeat(121) })).status).toBe(400);
    expect((await send({ model: '' })).status).toBe(400);
    expect((await send({ accountId: 'a b' })).status).toBe(400);
    expect((await send({ harness: 'auto', model: 'm'.repeat(120) })).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  describe('metering (coach plan, Task 2)', () => {
    const rows = () => db.prepare('SELECT * FROM plugin_assist WHERE plugin_id = ? ORDER BY at').all('coach') as Record<string, unknown>[];
    const full = (over: Partial<AssistResult> = {}): AssistRunner => ({
      available: async () => true,
      run: async () => ({ text: 'ok', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 4000, cacheCreateTokens: 50 }, ms: 300, model: 'claude-opus-5', harness: 'claude', accountId: 'work', costUsd: 0.25, ...over }),
    });

    it('a call records model, harness, account, cache tokens and cost', async () => {
      app = build(full());
      expect((await request(app).post('/api/plugins/coach/assist').set(asPlugin('coach')).send({ messages: [{ role: 'user', content: 'x' }] })).status).toBe(200);
      expect(rows()[0]).toMatchObject({ model: 'claude-opus-5', harness: 'claude', account_id: 'work', input_tokens: 100, output_tokens: 20, cache_read_tokens: 4000, cache_create_tokens: 50, cost_usd: 0.25, ms: 300, ok: 1 });
      // No cost from the harness: priced from the tokens when the model is known (Opus: $5 in, $25 out, cache read 0.5, write 6.25 per million).
      app = build(full({ costUsd: null }));
      await request(app).post('/api/plugins/coach/assist').set(asPlugin('coach')).send({ messages: [{ role: 'user', content: 'x' }] });
      expect(rows()[1].cost_usd as number).toBeCloseTo((100 * 5 + 20 * 25 + 4000 * 0.5 + 50 * 6.25) / 1e6, 9);
      // An unknown model with no cost stays unknown (null), never 0.
      app = build(full({ costUsd: null, model: 'mystery-1' }));
      await request(app).post('/api/plugins/coach/assist').set(asPlugin('coach')).send({ messages: [{ role: 'user', content: 'x' }] });
      expect(rows()[2].cost_usd).toBeNull();
    });

    it('a failed call is a row with ok=0', async () => {
      app = build({ available: async () => true, run: async () => null });
      const r = await request(app).post('/api/plugins/coach/assist').set(asPlugin('coach')).send({ messages: [{ role: 'user', content: 'x' }], harness: 'codex', model: 'gpt-5.6-sol' });
      expect(r.status).toBe(502);
      expect(rows()).toEqual([expect.objectContaining({ ok: 0, harness: 'codex', model: 'gpt-5.6-sol', input_tokens: 0, output_tokens: 0 })]);
      const usage = (await request(app).get('/api/plugins/coach/assist/usage').set(asPlugin('coach'))).body;
      expect(usage).toMatchObject({ calls: 1, failed: 1 });
    });

    it('usage between from and to sums by model', async () => {
      const rec = (at: string, model: string, harness: string, i: number, o: number, cost: number | null) => pluginData.recordAssist(db, 'coach', { at, model, harness, accountId: 'cli', inputTokens: i, outputTokens: o, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: cost, ms: 1, ok: true });
      rec('2026-10-01T10:00:00.000Z', 'claude-haiku-5-5', 'claude', 100, 10, 0.01);
      rec('2026-10-02T10:00:00.000Z', 'claude-haiku-5-5', 'claude', 200, 20, 0.02);
      rec('2026-10-03T10:00:00.000Z', 'claude-opus-5', 'claude', 1000, 100, 0.5);
      rec('2026-10-09T10:00:00.000Z', 'claude-opus-5', 'claude', 9999, 999, 9);
      pluginData.recordAssist(db, 'mute', { at: '2026-10-02T00:00:00.000Z', model: 'm', harness: 'claude', accountId: null, inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 1, ms: 1, ok: true });
      const r = await request(app).get('/api/plugins/coach/assist/usage?from=2026-10-01T00:00:00.000Z&to=2026-10-05T00:00:00.000Z').set(asPlugin('coach'));
      expect(r.status).toBe(200);
      expect(r.body.calls).toBe(3);
      expect(r.body.failed).toBe(0);
      expect(r.body.inputTokens).toBe(1300);
      expect(r.body.outputTokens).toBe(130);
      expect(r.body.costUsd).toBeCloseTo(0.53, 9);
      expect(r.body.byModel).toEqual([
        { model: 'claude-opus-5', harness: 'claude', calls: 1, inputTokens: 1000, outputTokens: 100 },
        { model: 'claude-haiku-5-5', harness: 'claude', calls: 2, inputTokens: 300, outputTokens: 30 },
      ]);
      // The owner reads it too; no `from` means the last 7 days.
      const recent = await request(app).get('/api/plugins/coach/assist/usage');
      expect(recent.status).toBe(200);
      expect(recent.body.calls).toBe(0);
      expect((await request(app).get('/api/plugins/coach/assist/usage?from=yesterday')).status).toBe(400);
    });

    it("another plugin's key gets 403", async () => {
      expect((await request(app).get('/api/plugins/coach/assist/usage').set(asPlugin('mute'))).status).toBe(403);
      const thread = { Authorization: `Bearer ${app.locals.keys.mint({ kind: 'thread', terminalId: 'tX' }).key}` };
      expect((await request(app).get('/api/plugins/coach/assist/usage').set(thread)).status).toBe(403);
    });

    it('the Plugins row shows the last 7 days with failures and cost', async () => {
      app = build(full());
      await request(app).post('/api/plugins/coach/assist').set(asPlugin('coach')).send({ messages: [{ role: 'user', content: 'x' }] });
      pluginData.recordAssist(db, 'coach', { at: '2020-01-01T00:00:00.000Z', model: 'm', harness: 'claude', accountId: null, inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 1, ms: 1, ok: true });
      const row = (await request(app).get('/api/plugins')).body.plugins.find((p: any) => p.id === 'coach');
      expect(row.assist).toEqual({ calls: 1, failed: 0, inputTokens: 100, outputTokens: 20, costUsd: 0.25, days: 7 });
    });
  });

  it('the share route gives the 5-hour and weekly estimate for an account (coach plan, Task 3)', async () => {
    const now = Date.now();
    summary = { type: 'usage-limits', at: now, epoch: 'e', rev: 1, warnPercent: 80, pushOnWarn: false, paused: [],
      providers: [{ provider: 'claude-code', accountId: 'cli', label: 'cli', asOf: now, windows: { five_hour: { usedPercent: 40, resetsAt: now + 3_600_000 }, seven_day: { usedPercent: 12, resetsAt: now + 86_400_000 } } }] };
    pluginData.recordAssist(db, 'coach', { at: new Date(now - 60_000).toISOString(), model: 'claude-opus-5', harness: 'claude', accountId: 'cli', inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: null, ms: 1, ok: true });
    plugin('coach', ['model:assist', 'read:usage']); // usage figures need read:usage
    app = build(fakeRunner);
    const r = await request(app).get('/api/plugins/coach/assist/share?accountId=cli').set(asPlugin('coach'));
    expect(r.status).toBe(200);
    // The plugin is the only Dispatch use of the account in the window: the whole used percent.
    expect(r.body.fiveHour).toMatchObject({ usedPercent: 40, pluginPercent: 40, pluginTokens: 110 });
    expect(r.body.sevenDay).toMatchObject({ usedPercent: 12, pluginPercent: 12 });
    // An account the summary does not know: nulls, not zeros.
    expect((await request(app).get('/api/plugins/coach/assist/share?accountId=work').set(asPlugin('coach'))).body).toEqual({ fiveHour: null, sevenDay: null });
    expect((await request(app).get('/api/plugins/coach/assist/share?harness=nope').set(asPlugin('coach'))).status).toBe(400);
    expect((await request(app).get('/api/plugins/coach/assist/share').set(asPlugin('mute'))).status).toBe(403);
  });

  it('assist with no runner answers 503 with a plain message', async () => {
    app = build(null);
    const r = await request(app).post('/api/plugins/coach/assist').set(asPlugin('coach')).send({ messages: [{ role: 'user', content: 'x' }] });
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'no_model', message: 'No model is signed in for assist. Sign in to Claude Code or set an OpenRouter key.' });
  });

  it('the owner can call assist for a plugin; a bad body is 400; maxTokens is capped at 2000', async () => {
    const r = await request(app).post('/api/plugins/coach/assist').send({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 99999 });
    expect(r.status).toBe(200);
    expect(calls[0].maxTokens).toBe(2000);
    expect((await request(app).post('/api/plugins/coach/assist').send({})).status).toBe(400);
    expect((await request(app).post('/api/plugins/coach/assist').send({ messages: 'nope' })).status).toBe(400);
    expect((await request(app).post('/api/plugins/nope/assist').send({ messages: [{ role: 'user', content: 'x' }] })).status).toBe(404);
  });
});
