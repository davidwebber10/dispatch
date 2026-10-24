import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDatabase } from '../db/connection.js';
import { createUsageLimitsRouter } from './usage-limits.js';
import { LimitSnapshots } from '../limits/snapshot.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import * as parksDb from '../db/usage-limits.js';

let db: ReturnType<typeof createDatabase>;
let snaps: LimitSnapshots;
const NOW = 1_792_800_000_000;
const term = (id: string, type: string) => {
  if (!sessionsDb.getById(db, 'p')) sessionsDb.create(db, { id: 'p', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  terminalsDb.create(db, { id, sessionId: 'p', type, label: 'T' });
};
let account = 'acct-A';
let loginChangedAt = 0;
let sessionsRoot = '';
const app = () => { const a = express(); a.use('/api', createUsageLimitsRouter(db, snaps, { now: () => NOW, accountFor: () => account, codexLoginChangedAt: () => loginChangedAt, codexRoots: { sessions: sessionsRoot, archived: path.join(sessionsRoot, 'none') } })); return a; };

beforeEach(() => {
  db = createDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ul-route-')), 't.db'));
  snaps = new LimitSnapshots(db);
  account = 'acct-A'; loginChangedAt = 0;
  sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ul-codex-'));
});

describe('GET /api/usage-limits', () => {
  it('404 for an unknown thread', async () => {
    expect((await request(app()).get('/api/usage-limits?terminalId=nope')).status).toBe(404);
  });
  it('a Claude thread gets the shared snapshot; grok and opencode are unsupported', async () => {
    term('c1', 'claude-code'); term('g1', 'grok'); term('o1', 'opencode');
    snaps.record('claude-code', 'acct-A', { five_hour: { usedPercent: 62, resetsAt: NOW + 1000 } }, NOW);
    const c = (await request(app()).get('/api/usage-limits?terminalId=c1')).body;
    expect(c.supported).toBe(true);
    expect(c.snapshot.windows.five_hour.usedPercent).toBe(62);
    for (const id of ['g1', 'o1']) {
      const b = (await request(app()).get(`/api/usage-limits?terminalId=${id}`)).body;
      expect(b).toMatchObject({ supported: false, snapshot: null });
    }
  });
  it('shows the pause #106 put on the thread, but not a woken one', async () => {
    term('c1', 'claude-code');
    parksDb.upsert(db, { terminal_id: 'c1', provider: 'claude-code', kind: 'session', resets_at: NOW + 5000, wake_at: NOW + 6000, message: 'm', parsed: 1, attempts: 0, state: 'parked', parked_at: NOW }, NOW);
    expect((await request(app()).get('/api/usage-limits?terminalId=c1')).body.paused).toEqual({ kind: 'session', resetsAt: NOW + 5000, capped: false });
    parksDb.setState(db, 'c1', 'woken', 1, NOW, NOW);
    expect((await request(app()).get('/api/usage-limits?terminalId=c1')).body.paused).toBeNull();
  });
});

const EXT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const codexFile = (ts: string, rl: unknown) => {
  fs.writeFileSync(path.join(sessionsRoot, `rollout-2026-10-24T08-00-00-${EXT}.jsonl`), JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: rl } }) + '\n');
};
const codexTerm = () => { term('x1', 'codex'); db.prepare('UPDATE terminals SET external_id = ? WHERE id = ?').run(EXT, 'x1'); };
const RL = { primary: { used_percent: 41, window_minutes: 300, resets_at: 1792861200 }, secondary: { used_percent: 12, window_minutes: 10080, resets_at: 1793062800 }, plan_type: 'plus' };

describe('account switches and the Codex file', () => {
  it('a snapshot from another account is not shown as current', async () => {
    term('c1', 'claude-code');
    snaps.record('claude-code', 'acct-A', { five_hour: { usedPercent: 99, resetsAt: NOW + 1000 } }, NOW);
    expect((await request(app()).get('/api/usage-limits?terminalId=c1')).body.snapshot.windows.five_hour.usedPercent).toBe(99);
    account = 'acct-B';
    expect((await request(app()).get('/api/usage-limits?terminalId=c1')).body.snapshot).toBeNull();
    account = '';
    expect((await request(app()).get('/api/usage-limits?terminalId=c1')).body.snapshot).toBeNull();
  });
  it('a Codex thread reads its session file, tags the figures with the current account, and is throttled to 30 s', async () => {
    codexTerm(); codexFile('2026-10-24T12:00:00.000Z', RL);
    const a = app();
    const b = (await request(a).get('/api/usage-limits?terminalId=x1')).body;
    expect(b.snapshot).toMatchObject({ account: 'acct-A', plan: 'plus', windows: { five_hour: { usedPercent: 41 }, seven_day: { usedPercent: 12 } } });
    codexFile('2026-10-24T13:00:00.000Z', { ...RL, primary: { ...RL.primary, used_percent: 90 } });
    expect((await request(a).get('/api/usage-limits?terminalId=x1')).body.snapshot.windows.five_hour.usedPercent).toBe(41); // within 30 s: not re-read
  });
  it('figures written before the login file changed are not claimed by the new account', async () => {
    codexTerm(); codexFile('2026-10-24T12:00:00.000Z', RL);
    loginChangedAt = Date.parse('2026-10-24T12:30:00.000Z');
    expect((await request(app()).get('/api/usage-limits?terminalId=x1')).body.snapshot).toBeNull();
  });
  it('an old thread file cannot undo newer shared figures', async () => {
    codexTerm(); codexFile('2026-10-23T08:00:00.000Z', { ...RL, primary: { ...RL.primary, used_percent: 5 } });
    snaps.record('codex', 'acct-A', { five_hour: { usedPercent: 80, resetsAt: 1792861200_000 } }, Date.parse('2026-10-24T12:00:00.000Z'), 'plus', true);
    expect((await request(app()).get('/api/usage-limits?terminalId=x1')).body.snapshot.windows.five_hour.usedPercent).toBe(80);
  });
  it('an unlimited-plan report (both windows null) clears earlier limited figures', async () => {
    codexTerm(); codexFile('2026-10-24T13:00:00.000Z', { primary: null, secondary: null, plan_type: 'business' });
    snaps.record('codex', 'acct-A', { five_hour: { usedPercent: 80, resetsAt: 1792861200_000 } }, Date.parse('2026-10-24T12:00:00.000Z'), 'plus', true);
    expect((await request(app()).get('/api/usage-limits?terminalId=x1')).body.snapshot.windows).toEqual({});
  });
});
