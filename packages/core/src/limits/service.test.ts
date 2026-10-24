import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import * as parksDb from '../db/usage-limits.js';
import { UsageLimitService, RESUME_TEXT } from './service.js';

const ZONE = 'America/Indianapolis';
const T0 = Date.UTC(2026, 9, 24, 4, 31); // 00:31 local
const RESET = Date.UTC(2026, 9, 24, 5, 10);
const MIN = 60_000;

let db: Database.Database;
let clock: number;
let wakes: { id: string; text: string }[];
let labels: { id: string; label: string }[];
let notes: { id: string; text: string; deliver: boolean }[];
let wakeError: Error | null;
let svc: UsageLimitService;

function thread(id: string, status = 'scheduled', archived = false): void {
  if (!sessionsDb.getById(db, 'proj')) sessionsDb.create(db, { id: 'proj', provider: 'claude-code', name: 'p', workingDir: '/tmp/p' });
  terminalsDb.create(db, { id, sessionId: 'proj', type: 'claude-code', label: `Thread ${id}`, config: { transport: 'structured' } });
  terminalsDb.updateStatus(db, id, status);
  if (archived) db.prepare("UPDATE terminals SET archived_at = 'x' WHERE id = ?").run(id);
}
const session = { kind: 'session' as const, resetsAt: RESET, message: "You've hit your session limit · resets 1:10am (America/Indianapolis)" };

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  clock = T0; wakes = []; labels = []; notes = []; wakeError = null;
  svc = new UsageLimitService({
    db, now: () => clock, zone: ZONE,
    wake: (id, text) => { if (wakeError) throw wakeError; wakes.push({ id, text }); },
    markPaused: (id, label) => labels.push({ id, label }),
    note: (id, text, opts) => notes.push({ id, text, deliver: opts.deliver }),
  });
});
afterEach(() => { svc.stop(); db.close(); });

describe('park', () => {
  it('stores the stop, labels the thread, and tells Chat once', () => {
    thread('a');
    svc.park('a', 'claude-code', session);
    expect(parksDb.get(db, 'a')).toMatchObject({ kind: 'session', resets_at: RESET, state: 'parked', attempts: 0, parsed: 1, provider: 'claude-code' });
    expect(parksDb.get(db, 'a')!.wake_at).toBe(RESET + 90_000);
    expect(labels).toEqual([{ id: 'a', label: 'Paused: session limit, resumes 1:10 AM' }]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ id: 'a', deliver: false });
    expect(notes[0].text).toContain('Thread a');
    expect(notes[0].text).toContain('session limit');
    expect(notes[0].text).toContain('1:10 AM');
  });
  it('a weekly pause names the weekday and sleeps until then', () => {
    thread('a');
    const monday = Date.UTC(2026, 9, 26, 13, 0);
    svc.park('a', 'claude-code', { kind: 'weekly', resetsAt: monday, message: 'weekly' });
    expect(labels[0].label).toBe('Paused: weekly limit, resumes Mon 9:00 AM');
    clock = monday - 10 * MIN;
    svc.tick();
    expect(wakes).toEqual([]);
  });
  it('an unreadable reset uses the fallback and says so', () => {
    thread('a'); thread('b');
    svc.park('a', 'claude-code', { kind: 'session', resetsAt: null, message: 'limit' });
    svc.park('b', 'claude-code', { kind: 'weekly', resetsAt: null, message: 'limit' });
    expect(parksDb.get(db, 'a')).toMatchObject({ parsed: 0, wake_at: T0 + 30 * MIN });
    expect(parksDb.get(db, 'b')).toMatchObject({ parsed: 0, wake_at: T0 + 6 * 60 * MIN });
    expect(labels[0].label).toBe('Paused: session limit, reset time unknown, retrying in 30 minutes');
    expect(notes[0].text).toContain('reset time unknown');
    expect(notes[0].text).toContain('30 minutes');
  });
  it('a reset already in the past waits only the buffer', () => {
    thread('a');
    svc.park('a', 'claude-code', { kind: 'session', resetsAt: T0 - 5 * MIN, message: 'x' });
    expect(parksDb.get(db, 'a')!.wake_at).toBe(T0 + 90_000);
  });
});

describe('tick / wake', () => {
  it('waits for the reset plus the buffer, then sends the resume text once', () => {
    thread('a');
    svc.park('a', 'claude-code', session);
    clock = RESET + 60_000;
    svc.tick();
    expect(wakes).toEqual([]);
    clock = RESET + 91_000;
    svc.tick(); svc.tick();
    expect(wakes).toEqual([{ id: 'a', text: RESUME_TEXT }]);
    expect(parksDb.get(db, 'a')).toMatchObject({ state: 'woken', attempts: 1 });
    expect(notes.at(-1)).toMatchObject({ deliver: false });
    expect(notes.at(-1)!.text).toMatch(/resumed|resumes/i);
  });
  it('staggers wakes of one provider; another provider is independent', () => {
    for (const id of ['a', 'b']) thread(id);
    thread('c'); db.prepare("UPDATE terminals SET type = 'codex' WHERE id = 'c'").run();
    svc.park('a', 'claude-code', session);
    svc.park('b', 'claude-code', session);
    svc.park('c', 'codex', session);
    clock = RESET + 5 * MIN;
    svc.tick();
    expect(wakes.map((w) => w.id).sort()).toEqual(['a', 'c']);
    clock += 10_000; svc.tick();
    expect(wakes).toHaveLength(2);
    clock += 15_000; svc.tick();
    expect(wakes.map((w) => w.id).sort()).toEqual(['a', 'b', 'c']);
  });
  it('hitting the limit again re-parks with the new time, keeps the count, posts no second pause note', () => {
    thread('a');
    svc.park('a', 'claude-code', session);
    clock = RESET + 2 * MIN; svc.tick();
    const notesBefore = notes.length;
    const later = RESET + 5 * 60 * MIN;
    svc.park('a', 'claude-code', { kind: 'session', resetsAt: later, message: 'again' });
    expect(parksDb.get(db, 'a')).toMatchObject({ state: 'parked', attempts: 1, resets_at: later });
    expect(notes).toHaveLength(notesBefore);
    clock = later + 2 * MIN; svc.tick();
    expect(wakes).toHaveLength(2);
  });
  it('stops at the cap and tells Chat, waking Chat', () => {
    thread('a');
    svc.park('a', 'claude-code', session);
    for (let i = 0; i < 5; i++) {
      clock += 6 * 60 * MIN; svc.tick();
      svc.park('a', 'claude-code', { kind: 'session', resetsAt: clock + MIN, message: 'again' });
    }
    expect(wakes).toHaveLength(5);
    expect(parksDb.get(db, 'a')!.state).toBe('capped');
    expect(notes.at(-1)).toMatchObject({ deliver: true });
    expect(notes.at(-1)!.text).toContain('5');
    clock += 24 * 60 * MIN; svc.tick();
    expect(wakes).toHaveLength(5);
  });
  it('a failed send counts as an attempt and retries later', () => {
    thread('a');
    svc.park('a', 'claude-code', session);
    clock = RESET + 2 * MIN;
    wakeError = new Error('thread process is not running');
    svc.tick();
    expect(parksDb.get(db, 'a')).toMatchObject({ state: 'parked', attempts: 1 });
    expect(parksDb.get(db, 'a')!.wake_at).toBeGreaterThan(clock);
  });
});

describe('guards', () => {
  it('drops the park of an archived or deleted thread', () => {
    thread('a', 'scheduled', true);
    svc.park('a', 'claude-code', session);
    clock = RESET + 2 * MIN; svc.tick();
    expect(wakes).toEqual([]);
    expect(parksDb.get(db, 'a')).toBeNull();
    parksDb.upsert(db, { terminal_id: 'ghost', provider: 'claude-code', kind: 'session', resets_at: RESET, wake_at: RESET, message: 'x', parsed: 1, attempts: 0, state: 'parked', parked_at: T0 }, T0);
    svc.tick();
    expect(parksDb.get(db, 'ghost')).toBeNull();
  });
  it('does not wake a thread that is already working', () => {
    thread('a', 'working');
    svc.park('a', 'claude-code', session);
    clock = RESET + 2 * MIN; svc.tick();
    expect(wakes).toEqual([]);
    expect(parksDb.get(db, 'a')).toBeNull();
  });
  it('the owner messaging the thread drops the park', () => {
    thread('a');
    svc.park('a', 'claude-code', session);
    svc.onUserMessage('a');
    clock = RESET + 2 * MIN; svc.tick();
    expect(wakes).toEqual([]);
    expect(parksDb.get(db, 'a')).toBeNull();
  });
  it('stop/archive drops the park', () => {
    thread('a');
    svc.park('a', 'claude-code', session);
    svc.onStopped('a');
    expect(parksDb.get(db, 'a')).toBeNull();
  });
  it('a finished turn clears a woken park but not a waiting one', () => {
    thread('a'); thread('b');
    svc.park('a', 'claude-code', session);
    svc.park('b', 'claude-code', session);
    clock = RESET + 2 * MIN; svc.tick();
    const woken = wakes[0].id;
    const other = woken === 'a' ? 'b' : 'a';
    svc.onTurnSettled(woken); svc.onTurnSettled(other);
    expect(parksDb.get(db, woken)).toBeNull();
    expect(parksDb.get(db, other)).not.toBeNull();
  });
});

describe('restart', () => {
  it('restore re-labels every live park, and drops dead ones', () => {
    thread('a'); thread('b', 'scheduled', true);
    svc.park('a', 'claude-code', session);
    svc.park('b', 'claude-code', session);
    labels.length = 0;
    svc.restore();
    expect(labels).toEqual([{ id: 'a', label: 'Paused: session limit, resumes 1:10 AM' }]);
    expect(parksDb.get(db, 'b')).toBeNull();
  });
  it('a weekly park keeps its wake time across a new service instance and does not retry early', () => {
    thread('a');
    const monday = Date.UTC(2026, 9, 26, 13, 0);
    svc.park('a', 'claude-code', { kind: 'weekly', resetsAt: monday, message: 'w' });
    svc.stop();
    const again = new UsageLimitService({ db, now: () => clock, zone: ZONE, wake: (id, t) => wakes.push({ id, text: t }), markPaused: () => {}, note: () => {} });
    clock = monday - 60 * MIN; again.tick();
    expect(wakes).toEqual([]);
    clock = monday + 2 * MIN; again.tick();
    expect(wakes).toHaveLength(1);
    again.stop();
  });
});
