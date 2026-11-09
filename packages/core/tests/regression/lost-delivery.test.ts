// Regression (engineering review, top 15 #3; reliability #1): a message for a thread that could not
// take it was logged and lost, and a one-shot watch was spent though its wake never arrived.
// Two "daemons" (two sets of services, two database handles) on ONE database file, as a real
// restart is. Real SessionService, StatusService, WatchDispatcher and DeliveryOutbox; the harness
// events come through the real adapter from a fake manager.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as watchesDb from '../../src/db/watches.js';
import { SessionService } from '../../src/sessions/service.js';
import { StatusService } from '../../src/status/service.js';
import { WatchDispatcher } from '../../src/sessions/watch-dispatcher.js';
import { subscribeHarnessEvents } from '../../src/runtime/adapter.js';
import { PTYManager } from '../../src/pty/manager.js';
import { DeliveryOutbox } from '../../src/delivery/outbox.js';
import { createDeliveryOutbox, subscribeDeliveryOutbox, flushOutboxAtBoot } from '../../src/delivery/wiring.js';
import { buildWatchDeliver } from '../../src/server.js';
import type { IStructuredManager } from '../../src/structured/manager.js';

class FakePty extends PTYManager {
  alive = new Set<string>();
  writes: { id: string; data: string }[] = [];
  override spawn(): number { return 1; }
  override write(id: string, data: string): void { this.writes.push({ id, data }); }
  override resize(): void {}
  override kill(): void {}
  override getBuffer(): string { return ''; }
  override isAlive(id: string): boolean { return this.alive.has(id); }
  override killAll(): void {}
}

class FakeStructured extends EventEmitter {
  live = new Set<string>();
  sent: { id: string; content: unknown }[] = [];
  canSpawn = true;
  setDefaultEnv() {}
  spawn(id: string) { if (!this.canSpawn) throw new Error('spawn ENOENT'); this.live.add(id); return 4321; }
  sendMessage(id: string, content: unknown) { this.sent.push({ id, content }); }
  answerPermission() { return false; }
  getPending() { return null; }
  getSessionId() { return undefined; }
  getEvents() { return []; }
  getEventsTail() { return []; }
  getTurnTexts(): string[] | null { return null; }
  isAlive(id: string) { return this.live.has(id); }
  kill(id: string) { this.live.delete(id); }
  killAll() { this.live.clear(); }
  to(id: string) { return this.sent.filter((s) => s.id === id).map((s) => String(s.content)); }
}

let dir: string;
let dbPath: string;

/** One daemon life, wired the way server.ts wires it. Nothing in memory is shared with another life. */
function boot() {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);
  const pty = new FakePty();
  const svc = new SessionService(db, pty, path.join(dir, 'mcp.json'));
  const manager = new FakeStructured();
  svc.setStructuredManager(manager as unknown as IStructuredManager);
  svc.setStructuredCommandOverride({ command: 'fake', args: [] });
  const outbox = createDeliveryOutbox(db, svc, buildWatchDeliver(svc));
  const dispatcher = new WatchDispatcher(db, outbox);
  const status = new StatusService(db, { broadcast: vi.fn() }, undefined, (id, s) => dispatcher.onStatus(id, s));
  subscribeDeliveryOutbox(outbox, status);
  subscribeHarnessEvents(manager, (id) => (db.open ? terminalsDb.getById(db, id)?.type : undefined), (event) => {
    status.accept(event, (committed) => {
      if (committed.type === 'turn.completed' && committed.outcome === 'idle') svc.noteAgentCompletion(committed.terminalId);
    });
  });
  /** A full turn of a structured thread: the events a real process sends. */
  const turn = (id: string) => { manager.live.add(id); manager.emit('busy', id); manager.emit('idle', id, {}); };
  return { db, pty, svc, manager, outbox, status, dispatcher, turn };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lost-delivery-'));
  dbPath = path.join(dir, 'dispatch.db');
  const db = new Database(dbPath);
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: dir });
  // The coordinator of this worker: the thread that started it. A CLI lead too, for the PTY path.
  terminalsDb.create(db, { id: 'lead', sessionId: 's1', type: 'claude-code', label: 'Lead', config: { transport: 'structured' } });
  terminalsDb.create(db, { id: 'cli-lead', sessionId: 's1', type: 'claude-code', label: 'CLI lead', config: {} });
  terminalsDb.create(db, { id: 'w', sessionId: 's1', type: 'claude-code', label: 'Worker', config: { transport: 'structured', role: 'agent', mission: 'fix it', spawnedBy: 'lead', spawnDepth: 1 } });
  db.close();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('lost delivery', () => {
  it('a Finished notice sent while the coordinator is down arrives once after it starts', () => {
    const first = boot();
    first.turn('w'); // the worker finishes; its coordinator is not running
    expect(first.manager.to('lead')).toHaveLength(0);
    expect(first.outbox.list({ terminalId: 'lead' })).toMatchObject([{ state: 'pending', kind: 'notice', source_terminal_id: 'w' }]);
    // kill -9: nothing is closed, nothing in memory survives.

    const second = boot();
    expect(flushOutboxAtBoot(second.outbox).delivered).toBe(0); // the boot flush does not start the coordinator
    expect(second.manager.live.has('lead')).toBe(false);
    expect(second.outbox.list({ terminalId: 'lead' })).toMatchObject([{ state: 'pending', attempts: 0 }]);

    // The coordinator runs again: its first event is its process start.
    second.manager.live.add('lead');
    second.manager.emit('busy', 'lead');
    expect(second.manager.to('lead')).toHaveLength(1);
    expect(second.manager.to('lead')[0]).toContain('"Worker"');
    expect(second.manager.to('lead')[0]).toContain('just finished a turn');
    const [row] = second.outbox.list({ terminalId: 'lead' });
    expect(row).toMatchObject({ state: 'delivered' });
    expect(row.delivered_at).toBeTruthy();

    // Every later event of the coordinator, and a third daemon: exactly one message, ever.
    second.manager.emit('idle', 'lead', {});
    second.manager.emit('busy', 'lead');
    second.manager.emit('idle', 'lead', {});
    expect(second.manager.to('lead')).toHaveLength(1);
    const third = boot();
    flushOutboxAtBoot(third.outbox);
    third.manager.live.add('lead');
    third.manager.emit('busy', 'lead');
    expect(third.manager.to('lead')).toHaveLength(0);
    first.db.close(); second.db.close(); third.db.close();
  });

  it('a notice for a coordinator that is alive is delivered at once, with no restart', () => {
    const d = boot();
    d.manager.live.add('lead');
    d.turn('w');
    expect(d.manager.to('lead')).toHaveLength(1);
    expect(d.outbox.list({ terminalId: 'lead' })).toMatchObject([{ state: 'delivered' }]);
    d.db.close();
  });

  it('a pending notice is delivered when a coordinator that already runs settles its turn', () => {
    const first = boot();
    first.turn('w');
    const second = boot();
    // The process started before the row could be tried (the start event came first): the settle edge is the second event.
    second.manager.live.add('lead');
    second.status.markWorking('lead');
    second.status.markIdle('lead');
    expect(second.manager.to('lead')).toHaveLength(1);
    first.db.close(); second.db.close();
  });

  it('a CLI coordinator that is down gets the notice typed in once, after its next turn settles', () => {
    const first = boot();
    terminalsDb.updateConfig(first.db, 'w', { transport: 'structured', role: 'agent', spawnedBy: 'cli-lead', spawnDepth: 1 });
    first.turn('w');
    expect(first.pty.writes).toHaveLength(0);
    const second = boot();
    flushOutboxAtBoot(second.outbox);
    expect(second.pty.writes).toHaveLength(0);
    second.pty.alive.add('cli-lead');
    second.status.ingest('claude', 'cli-lead', { hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
    second.status.ingest('claude', 'cli-lead', { hook_event_name: 'Stop' });
    expect(second.pty.writes.filter((w) => w.id === 'cli-lead')).toHaveLength(1);
    expect(second.pty.writes[0].data).toContain('just finished a turn');
    second.status.ingest('claude', 'cli-lead', { hook_event_name: 'UserPromptSubmit', prompt: 'again' });
    second.status.ingest('claude', 'cli-lead', { hook_event_name: 'Stop' });
    expect(second.pty.writes.filter((w) => w.id === 'cli-lead')).toHaveLength(1);
    first.db.close(); second.db.close();
  });

  it('a one-shot watch whose delivery failed fires on the next start', () => {
    const first = boot();
    const watchId = watchesDb.create(first.db, { watcherTerminalId: 'lead', targetTerminalId: 'w', criteria: 'idle', note: 'review it' });
    first.manager.canSpawn = false; // the watcher cannot be started now
    vi.spyOn(console, 'error').mockImplementation(() => {});
    first.turn('w');
    const fired = () => (first.db.prepare('SELECT fired_at FROM thread_watches WHERE id = ?').get(watchId) as { fired_at: string | null }).fired_at;
    expect(first.manager.to('lead')).toHaveLength(0);
    expect(fired()).toBeNull(); // before the delivery
    expect(first.outbox.list({ terminalId: 'lead', state: 'pending' }).some((r) => r.kind === 'watch')).toBe(true);

    const second = boot();
    second.manager.live.add('lead');
    second.manager.emit('busy', 'lead'); // the watcher's process started
    const wakes = second.manager.to('lead').filter((t) => t.includes('You asked to watch it'));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain('review it');
    expect(fired()).toBeTruthy(); // after it
    second.manager.emit('idle', 'lead', {});
    expect(second.manager.to('lead').filter((t) => t.includes('You asked to watch it'))).toHaveLength(1);
    first.db.close(); second.db.close();
  });

  it('a one-shot watch of a CLI watcher that is down stays live and fires after its next turn', () => {
    const first = boot();
    const watchId = watchesDb.create(first.db, { watcherTerminalId: 'cli-lead', targetTerminalId: 'w', criteria: 'idle' });
    first.turn('w');
    const row = (db: Database.Database) => db.prepare('SELECT fired_at, pending_delivery_id FROM thread_watches WHERE id = ?').get(watchId) as { fired_at: string | null; pending_delivery_id: number | null };
    expect(first.pty.writes).toHaveLength(0); // before: the wake was typed into nothing and the watch was spent
    expect(row(first.db).fired_at).toBeNull();
    expect(row(first.db).pending_delivery_id).not.toBeNull();
    first.turn('w'); // a second settle of the target does not make a second wake
    expect(first.outbox.list({ terminalId: 'cli-lead' }).filter((r) => r.kind === 'watch')).toHaveLength(1);

    const second = boot();
    second.pty.alive.add('cli-lead');
    second.status.ingest('claude', 'cli-lead', { hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
    second.status.ingest('claude', 'cli-lead', { hook_event_name: 'Stop' });
    expect(second.pty.writes.filter((w) => w.data.includes('finished its turn'))).toHaveLength(1);
    expect(row(second.db).fired_at).toBeTruthy();
    first.db.close(); second.db.close();
  });

  it('the same settle event enqueues one row', () => {
    const d = boot();
    d.turn('w');
    // The same event handled again (a duplicate frame, a listener wired twice): no second row, no second message.
    d.svc.noteAgentCompletion('w');
    d.svc.noteAgentCompletion('w');
    const rows = d.outbox.list({ terminalId: 'lead' });
    expect(rows).toHaveLength(1);
    expect(rows[0].dedup_key).toMatch(/^notice:w:finished:[0-9a-f-]{36}:\d+$/);
    d.manager.live.add('lead');
    d.outbox.flush('lead');
    expect(d.manager.to('lead')).toHaveLength(1);
    // The next turn of the worker is a new event: a new row.
    d.turn('w');
    expect(d.outbox.list({ terminalId: 'lead' })).toHaveLength(2);
    expect(d.manager.to('lead')).toHaveLength(2);
    d.db.close();
  });

  it('a daemon that dies during the delivery sends the row again after the restart, and only that row', () => {
    const db = new Database(dbPath);
    initSchema(db);
    const sent: string[] = [];
    const done = new DeliveryOutbox({ db, deliver: (_to, body) => { sent.push(body); return 'delivered'; } });
    done.enqueue({ targetId: 'lead', kind: 'notice', body: 'done before the kill', dedupKey: 'k1' });
    // The process dies inside deliver: the message left, the row was never marked delivered.
    const dying = new DeliveryOutbox({ db, deliver: (_to, body) => { sent.push(body); throw new Error('daemon killed'); } });
    dying.enqueue({ targetId: 'lead', kind: 'notice', body: 'in flight', dedupKey: 'k2' });
    expect(sent).toEqual(['done before the kill', 'in flight']);

    const afterRestart: string[] = [];
    const next = new DeliveryOutbox({ db, deliver: (_to, body) => { afterRestart.push(body); return 'delivered'; } });
    expect(flushOutboxAtBoot(next).delivered).toBe(1);
    expect(afterRestart).toEqual(['in flight']); // at least once for the row in flight; never again for the delivered row
    expect(next.list({ state: 'pending' })).toHaveLength(0);
    db.close();
  });

  it('the boot flush removes old delivered rows and keeps pending ones', () => {
    const d = boot();
    d.turn('w');
    d.db.prepare("UPDATE delivery_outbox SET created_at = '2020-01-01T00:00:00.000Z'").run();
    d.manager.live.add('lead');
    d.turn('w');
    d.db.prepare("UPDATE delivery_outbox SET created_at = '2020-01-01T00:00:00.000Z' WHERE state = 'delivered'").run();
    d.manager.live.delete('lead');
    d.turn('w');
    d.db.prepare("UPDATE delivery_outbox SET created_at = '2020-01-01T00:00:00.000Z'").run();
    const second = boot();
    expect(flushOutboxAtBoot(second.outbox).pruned).toBe(2);
    expect(second.outbox.list({ terminalId: 'lead' })).toMatchObject([{ state: 'pending' }]);
    d.db.close(); second.db.close();
  });
});
