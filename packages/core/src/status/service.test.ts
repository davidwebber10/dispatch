// W3-C, one status authority: StatusService is the one writer of a thread's status. `snapshot()` is what
// every reader gets (the structured socket header, the `terminal:status` event, GET .../status).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { StatusService } from './service.js';
import type { StatusSnapshot } from './events.js';

let db: Database.Database;
let broadcaster: { broadcast: ReturnType<typeof vi.fn> };
let status: StatusService;

const statusEvents = (id = 't1') => broadcaster.broadcast.mock.calls.map((c) => c[0]).filter((e: any) => e.type === 'terminal:status' && e.terminalId === id);

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 'p1', provider: 'claude-code', name: 'P', workingDir: '/tmp/p' });
  terminalsDb.create(db, { id: 't1', sessionId: 'p1', type: 'claude-code', label: 'one' });
  terminalsDb.create(db, { id: 't2', sessionId: 'p1', type: 'codex', label: 'two' });
  broadcaster = { broadcast: vi.fn() };
  status = new StatusService(db, broadcaster);
});

describe('StatusService.snapshot', () => {
  it('snapshot equals the last committed transition', () => {
    const seen: StatusSnapshot[] = [];
    status.onStatus((id, snapshot) => { if (id === 't1') seen.push(snapshot); });

    status.markWorking('t1', 'Thinking…');
    expect(status.snapshot('t1')).toEqual(seen[0]);
    expect(seen[0]).toMatchObject({ status: 'working', turnOpen: true, activity: 'Thinking…' });

    status.markIdle('t1');
    expect(seen).toHaveLength(2);
    expect(status.snapshot('t1')).toEqual(seen[1]);
    expect(seen[1]).toMatchObject({ status: 'idle', turnOpen: false, activity: null });
    expect(typeof seen[1].at).toBe('string');
    // The mirror column holds the same status.
    expect(terminalsDb.getById(db, 't1')!.status).toBe('waiting');
  });

  it('each committed transition has the next sequence, in one generation', () => {
    const seen: StatusSnapshot[] = [];
    status.onStatus((_id, snapshot) => seen.push(snapshot));
    status.markWorking('t1');
    status.markNeedsInput('t1', 'Approve Bash?');
    status.markWorking('t2');
    status.markFailed('t1');
    expect(seen.map((s) => s.sequence)).toEqual([seen[0].sequence, seen[0].sequence + 1, seen[0].sequence + 2, seen[0].sequence + 3]);
    expect(new Set(seen.map((s) => s.generation)).size).toBe(1);
    expect(seen.map((s) => s.turnOpen)).toEqual([true, false, true, false]);
  });

  it('a thread with no transition yet reads its stored status at sequence 0', () => {
    expect(status.snapshot('t1')).toMatchObject({ status: 'idle', turnOpen: false, sequence: 0, activity: null });
    expect(status.snapshot('missing')).toBeNull();
  });

  it('the terminal:status event carries turnOpen, generation and sequence of the same snapshot', () => {
    status.markWorking('t1', 'Working…');
    const snapshot = status.snapshot('t1')!;
    expect(statusEvents()).toEqual([{
      type: 'terminal:status', terminalId: 't1', status: 'working', threadStatus: 'working', activity: 'Working…',
      turnOpen: true, generation: snapshot.generation, sequence: snapshot.sequence,
    }]);
  });

  it('a reset, an inferred status and a process exit are transitions too', () => {
    const seen: StatusSnapshot[] = [];
    status.onStatus((id, snapshot) => { if (id === 't2') seen.push(snapshot); });
    status.markInferred('t2', 'working');
    status.markInferred('t2', 'waiting');
    status.markWorking('t2');
    status.resetStatus('t2');
    status.markWorking('t2');
    status.markExited('t2', 1);
    expect(seen.map((s) => [s.status, s.turnOpen])).toEqual([
      ['working', true], ['idle', false], ['working', true], ['idle', false], ['working', true], ['error', false],
    ]);
    for (let i = 1; i < seen.length; i++) expect(seen[i].sequence).toBeGreaterThan(seen[i - 1].sequence);
    expect(statusEvents('t2').every((e: any) => typeof e.sequence === 'number' && typeof e.turnOpen === 'boolean')).toBe(true);
  });

  it('a new daemon on the same database has a higher generation, and reads the stored status', () => {
    status.markWorking('t1');
    const before = status.snapshot('t1')!;
    const next = new StatusService(db, { broadcast: vi.fn() });
    const after = next.snapshot('t1')!;
    expect(after.generation).toBeGreaterThan(before.generation);
    expect(after).toMatchObject({ status: 'working', turnOpen: true, sequence: 0 });
  });

  it('a listener that throws does not stop the status write or the other listeners', () => {
    const seen: string[] = [];
    status.onStatus(() => { throw new Error('boom'); });
    const off = status.onStatus((id) => seen.push(id));
    status.markWorking('t1');
    off();
    status.markIdle('t1');
    expect(seen).toEqual(['t1']);
    expect(terminalsDb.getById(db, 't1')!.status).toBe('waiting');
  });

  it('the shutdown write-back of an interrupted turn goes through the service and sends nothing', () => {
    status.markWorking('t1');
    status.markExited('t1', 0);
    broadcaster.broadcast.mockClear();
    StatusService.restoreInterruptedTurn(db, 't1');
    expect(terminalsDb.getById(db, 't1')!.status).toBe('working');
    expect(broadcaster.broadcast).not.toHaveBeenCalled();
    // The next daemon reads it as an open turn (the boot kickstart continues it, or the reconcile settles it).
    expect(new StatusService(db, { broadcast: vi.fn() }).snapshot('t1')).toMatchObject({ status: 'working', turnOpen: true });
  });
});

describe('one writer', () => {
  // The guard: `terminals.status` is a mirror. Only status/service.ts may write it.
  it('no code path writes terminals.status outside apply', () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.fixture.ts')) files.push(full);
      }
    };
    walk(src);
    const offenders: string[] = [];
    let writersInService = 0;
    for (const file of files) {
      const rel = path.relative(src, file);
      const text = fs.readFileSync(file, 'utf8');
      // The definition itself (db/terminals.ts) is the one place the SQL lives.
      const rawSql = /UPDATE\s+terminals\s+SET\s+[^'"`]*\bstatus\s*=/i.test(text);
      const importsWriter = /import\s*\{[^}]*\bupdateStatus\b[^}]*\}\s*from\s*'[^']*db\/terminals\.js'/.test(text);
      const calls = (text.match(/terminalsDb\.updateStatus\(/g) ?? []).length;
      if (rel === path.join('db', 'terminals.ts')) continue;
      if (rel === path.join('status', 'service.ts')) { writersInService = calls; if (rawSql || importsWriter) offenders.push(rel); continue; }
      if (rawSql || importsWriter || calls > 0) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
    expect(writersInService).toBe(1); // one call site, inside the one write function
  });
});
