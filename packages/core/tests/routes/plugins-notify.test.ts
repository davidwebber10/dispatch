import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import { LimitSnapshots } from '../../src/limits/snapshot.js';
import type { UsageSummary } from '../../src/limits/gauge.js';
import { KeysManager } from './keys-manager.js';

/** Worker permissions for usage and analytics, and plugin push (coach plan, Task 5; coach spec sections 7.5, 9a.5). */
describe('plugin keys: read:usage, read:analytics, notify:push (coach plan, Task 5)', () => {
  let app: any; let db: Database.Database; let tmp: string;
  const plugin = (id: string, permissions: string[]) => {
    const dir = path.join(tmp, 'plugins', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', permissions }));
  };
  const asPlugin = (id: string) => ({ Authorization: `Bearer ${fs.readFileSync(path.join(tmp, 'keys', `plugin-${id}`), 'utf8').trim()}` });
  const summary: UsageSummary = { type: 'usage-limits', at: 1, epoch: 'e', rev: 1, warnPercent: 80, pushOnWarn: false, paused: [], providers: [] };

  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-notify-'));
    db = new Database(':memory:'); initSchema(db);
    plugin('coach', ['read:usage', 'read:analytics', 'notify:push']);
    plugin('bare', []);
    const mgr = new KeysManager();
    app = createApp({ db, skipPty: true, pluginsDir: path.join(tmp, 'plugins'), secretsDir: tmp, managers: new Map([['claude-code', mgr.asManager()]]),
      usageLimits: { snapshots: new LimitSnapshots(db), accountFor: () => 'acct', summary: () => summary } });
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('read:usage reaches the usage summary; without it, 403', async () => {
    const ok = await request(app).get('/api/usage-limits/summary').set(asPlugin('coach'));
    expect(ok.status).toBe(200);
    expect(ok.body.type).toBe('usage-limits');
    const no = await request(app).get('/api/usage-limits/summary').set(asPlugin('bare'));
    expect(no.status).toBe(403);
    expect(no.body.message).toContain('"read:usage"');
    // Only the summary: a thread's own figures and the reset credit stay owner-only.
    expect((await request(app).get('/api/usage-limits?terminalId=x').set(asPlugin('coach'))).status).toBe(403);
    expect((await request(app).post('/api/usage-limits/reset-credit').set(asPlugin('coach')).send({ provider: 'codex' })).status).toBe(403);
  });

  it('read:analytics reaches the analytics routes; without it, 403', async () => {
    for (const p of ['/api/analytics/summary', '/api/analytics/series', '/api/analytics/top', '/api/analytics/records', '/api/analytics/tracking']) {
      expect((await request(app).get(p).set(asPlugin('coach'))).status, p).toBe(200);
      const no = await request(app).get(p).set(asPlugin('bare'));
      expect(no.status, p).toBe(403);
      expect(no.body.message).toContain('"read:analytics"');
    }
  });

  it('notify sends through the push sender once and refuses the second within an hour', async () => {
    const push = app._pushService;
    const sent = vi.spyOn(push, 'notifyPlugin').mockResolvedValue(undefined);
    const r = await request(app).post('/api/plugins/coach/notify').set(asPlugin('coach')).send({ title: 'Your week with the Coach', body: 'Three patterns and one stretch.', url: '/plugins/coach' });
    expect(r.status).toBe(200);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledWith({ pluginId: 'coach', title: 'Your week with the Coach', body: 'Three patterns and one stretch.', url: '/plugins/coach' });
    const again = await request(app).post('/api/plugins/coach/notify').set(asPlugin('coach')).send({ title: 'x', body: 'y' });
    expect(again.status).toBe(429);
    expect(again.body.error).toBe('rate_limited');
    expect(again.body.retryAfterSeconds).toBeGreaterThan(3500);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('notify needs the permission, the own plugin key, and a sane body', async () => {
    const sent = vi.spyOn(app._pushService, 'notifyPlugin').mockResolvedValue(undefined);
    const no = await request(app).post('/api/plugins/bare/notify').set(asPlugin('bare')).send({ title: 'x', body: 'y' });
    expect(no.status).toBe(403);
    expect(no.body.message).toContain('"notify:push"');
    expect((await request(app).post('/api/plugins/bare/notify').set(asPlugin('coach')).send({ title: 'x', body: 'y' })).status).toBe(403);
    // The owner is not a plugin: a push from a plugin comes from its own key.
    expect((await request(app).post('/api/plugins/coach/notify').send({ title: 'x', body: 'y' })).status).toBe(403);
    expect((await request(app).post('/api/plugins/coach/notify').set(asPlugin('coach')).send({ title: '', body: 'y' })).status).toBe(400);
    expect((await request(app).post('/api/plugins/coach/notify').set(asPlugin('coach')).send({ title: 'x'.repeat(121), body: 'y' })).status).toBe(400);
    expect((await request(app).post('/api/plugins/coach/notify').set(asPlugin('coach')).send({ title: 'x', body: 'y', url: 'https://evil.example' })).status).toBe(400);
    expect((await request(app).post('/api/plugins/coach/notify').set(asPlugin('coach')).send({ title: 'x', body: 'y', url: '//evil.example' })).status).toBe(400);
    expect(sent).not.toHaveBeenCalled();
  });
});
