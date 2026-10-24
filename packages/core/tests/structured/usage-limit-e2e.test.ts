// A fake `claude` that hits the limit, driven through the real manager and the real limit
// service: park on the stop, wake after the reset, clear on the finished turn. Real limits cannot
// be triggered on demand, so the fake emits Claude Code 2.1.309's real frame shapes.
import { it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as parksDb from '../../src/db/usage-limits.js';
import { ClaudeStructuredSessionManager } from '../../src/structured/manager.js';
import { UsageLimitService, RESUME_TEXT } from '../../src/limits/service.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
let db: Database.Database;
let m: ClaudeStructuredSessionManager;
let svc: UsageLimitService;
const labels: string[] = [];
const notes: string[] = [];

async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('until timeout');
}

beforeEach(() => {
  labels.length = 0; notes.length = 0;
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp/p' });
  terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Returns', config: { transport: 'structured' } });
  terminalsDb.updateStatus(db, 't1', 'scheduled');
  m = new ClaudeStructuredSessionManager();
  svc = new UsageLimitService({
    db, wake: (id, text) => m.sendMessage(id, text),
    markPaused: (_id, label) => labels.push(label), note: (_id, text) => notes.push(text),
    options: { bufferMs: 0, staggerMs: 0, tickMs: 50 },
  });
  m.on('usage-limit', (id, limit) => svc.park(id, 'claude-code', limit));
  m.on('idle', (id) => svc.onTurnSettled(id));
  svc.start();
});
afterEach(() => { svc.stop(); m.kill('t1'); db.close(); });

it('stop on the session limit -> parked -> woken after the reset -> cleared by the finished turn', async () => {
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd() });
  const resetsAt = Math.ceil(Date.now() / 1000) + 2;
  m.sendMessage('t1', `TRIGGER_LIMIT:five_hour:${resetsAt}`);
  await until(() => parksDb.get(db, 't1') !== null);
  expect(parksDb.get(db, 't1')).toMatchObject({ kind: 'session', state: 'parked', resets_at: resetsAt * 1000 });
  expect(labels[0]).toMatch(/^Paused: session limit, resumes /);
  // Nothing wakes it before the reset.
  await new Promise((r) => setTimeout(r, 700));
  expect(parksDb.get(db, 't1')!.state).toBe('parked');
  // After the reset the thread gets the resume text; the fake answers it; the finished turn clears the park.
  await until(() => parksDb.get(db, 't1') === null);
  const events = m.getEvents('t1') as any[];
  expect(events.some((e) => e.type === 'assistant' && e.message?.content?.[0]?.text === `echo:${RESUME_TEXT}`)).toBe(true);
  expect(notes.some((n) => n.includes('resumed after the session limit (attempt 1 of 5)'))).toBe(true);
});

it('hits the limit again after a wake: parks again with the count kept, one pause note only, then finishes', async () => {
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), env: { FAKE_LIMIT_ON_RESUME: '1' } });
  m.sendMessage('t1', `TRIGGER_LIMIT:five_hour:${Math.ceil(Date.now() / 1000) + 1}`);
  await until(() => parksDb.get(db, 't1')?.attempts === 1 && parksDb.get(db, 't1')?.state === 'parked' && notes.some((n) => n.includes('attempt 1 of 5')));
  await until(() => parksDb.get(db, 't1') === null);
  expect(notes.filter((n) => n.includes('Paused:')).length).toBe(1);
  expect(notes.some((n) => n.includes('attempt 2 of 5'))).toBe(true);
});
