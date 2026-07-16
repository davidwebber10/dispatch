import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { ThreadAutoNamer } from '../../src/sessions/thread-auto-namer.js';
import type { EventBroadcaster } from '../../src/ws/events.js';

function createTestDb() {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

function fakeBroadcaster() {
  const events: Record<string, unknown>[] = [];
  const broadcaster: EventBroadcaster = { broadcast: (event) => { events.push(event); } };
  return { broadcaster, events };
}

const CC_TRANSCRIPT = '{"message":{"role":"user","content":"fix the flaky login test please"}}';

describe('ThreadAutoNamer', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    db = createTestDb();
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'test session', workingDir: '/work/proj' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('names a default-labeled claude thread once after the delay', async () => {
    terminalsDb.create(db, {
      id: 't1', sessionId: 's1', type: 'claude-code', label: 'Claude Code',
      externalId: 'ext-1', labelSource: 'default',
    });
    const { broadcaster, events } = fakeBroadcaster();
    const readFile = vi.fn().mockResolvedValue(CC_TRANSCRIPT);
    const namer = new ThreadAutoNamer(db, broadcaster, { readFile });

    namer.notifyActivity('t1');
    await vi.advanceTimersByTimeAsync(5000);

    const row = terminalsDb.getById(db, 't1')!;
    expect(row.label).toBe('fix the flaky login test please');
    expect(row.label_source).toBe('auto');
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ type: 'session:tabs-changed', sessionId: 's1' }]);

    namer.dispose();
  });

  it('debounce: 5 notifies collapse into one attempt', async () => {
    terminalsDb.create(db, {
      id: 't1', sessionId: 's1', type: 'claude-code', label: 'Claude Code',
      externalId: 'ext-1', labelSource: 'default',
    });
    const { broadcaster, events } = fakeBroadcaster();
    const readFile = vi.fn().mockResolvedValue(CC_TRANSCRIPT);
    const namer = new ThreadAutoNamer(db, broadcaster, { readFile });

    namer.notifyActivity('t1');
    namer.notifyActivity('t1');
    namer.notifyActivity('t1');
    namer.notifyActivity('t1');
    namer.notifyActivity('t1');
    await vi.advanceTimersByTimeAsync(5000);

    expect(readFile).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(terminalsDb.getById(db, 't1')!.label_source).toBe('auto');

    namer.dispose();
  });

  it('a user rename during the delay wins — no label overwrite, no broadcast', async () => {
    terminalsDb.create(db, {
      id: 't1', sessionId: 's1', type: 'claude-code', label: 'Claude Code',
      externalId: 'ext-1', labelSource: 'default',
    });
    const { broadcaster, events } = fakeBroadcaster();
    const readFile = vi.fn().mockResolvedValue(CC_TRANSCRIPT);
    const namer = new ThreadAutoNamer(db, broadcaster, { readFile });

    namer.notifyActivity('t1');
    // User renames the thread before the debounce timer fires.
    terminalsDb.updateLabel(db, 't1', 'My Custom Name');
    await vi.advanceTimersByTimeAsync(5000);

    const row = terminalsDb.getById(db, 't1')!;
    expect(row.label).toBe('My Custom Name');
    expect(row.label_source).toBe('user');
    expect(events).toHaveLength(0);

    namer.dispose();
  });

  it('gives up silently after 3 null attempts; a 4th notify schedules nothing', async () => {
    terminalsDb.create(db, {
      id: 't1', sessionId: 's1', type: 'claude-code', label: 'Claude Code',
      externalId: 'ext-1', labelSource: 'default',
    });
    const { broadcaster, events } = fakeBroadcaster();
    const readFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const namer = new ThreadAutoNamer(db, broadcaster, { readFile });

    namer.notifyActivity('t1');
    await vi.advanceTimersByTimeAsync(5000);
    namer.notifyActivity('t1');
    await vi.advanceTimersByTimeAsync(5000);
    namer.notifyActivity('t1');
    await vi.advanceTimersByTimeAsync(5000);

    expect(readFile).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);

    // 4th notify: attempts cap reached, nothing scheduled.
    namer.notifyActivity('t1');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);

    expect(readFile).toHaveBeenCalledTimes(3);
    const row = terminalsDb.getById(db, 't1')!;
    expect(row.label_source).toBe('default');
    expect(row.label).toBe('Claude Code');
    expect(events).toHaveLength(0);

    namer.dispose();
  });

  it('shell threads and non-default (auto/user) rows never schedule', async () => {
    terminalsDb.create(db, {
      id: 'shell1', sessionId: 's1', type: 'shell', label: 'Terminal',
      externalId: 'ext-shell', labelSource: 'default',
    });
    terminalsDb.create(db, {
      id: 'auto1', sessionId: 's1', type: 'claude-code', label: 'Already named',
      externalId: 'ext-auto', labelSource: 'auto',
    });
    terminalsDb.create(db, {
      id: 'user1', sessionId: 's1', type: 'claude-code', label: 'User named',
      externalId: 'ext-user', labelSource: 'user',
    });
    const { broadcaster, events } = fakeBroadcaster();
    const readFile = vi.fn().mockResolvedValue(CC_TRANSCRIPT);
    const namer = new ThreadAutoNamer(db, broadcaster, { readFile });

    namer.notifyActivity('shell1');
    namer.notifyActivity('auto1');
    namer.notifyActivity('user1');
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(10000);

    expect(readFile).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);

    namer.dispose();
  });
});
