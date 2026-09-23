// Task 9: a Codex coordinator must survive a daemon restart, and must not be mishandled by
// machinery that was written claude-transcript-first.
//
// Two things are pinned here:
//
//  1. Resume: the seed-events gate at service.ts's spawnStructured
//     (`resumeSessionId && terminal.type === 'claude-code' ? readSessionBackfill(...) : undefined`)
//     is claude-only BY DESIGN — Codex has no local transcript to backfill from; its own
//     manager restores history out-of-band via `thread/resume` (see codex-manager.ts's
//     `backfill`), driven by the `resumeId` field every structured spawn carries regardless
//     of harness. A Codex resume must still pass `resumeId` through, and must NOT pick up
//     claude seedEvents even when a same-named claude transcript happens to exist on disk.
//
//  2. Boot kickstart: `kickstartInterruptedAgents` re-prompts a coordinator/agent that was
//     stale-`working` when the daemon died. Idempotency reads the thread's own record of the
//     turn: the claude JSONL (transcriptTailStatus) for Claude, the Codex rollout
//     (codexRolloutTailStatus) for Codex — skip if already kicked and nothing moved since, skip
//     if the record shows the turn actually completed. (Review T1: this used to be claude-only,
//     so a Codex coordinator stopped mid-turn lost its directive until someone messaged it.)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { SessionService } from './service.js';
import { encodeClaudeProjectDir } from '../platform/encode.js';
import type { IStructuredManager, StructuredSpawnOpts } from '../structured/manager.js';

class FakePty extends EventEmitter {
  isAlive() { return false; }
  kill() {}
  spawn() { return 1234; }
  setDefaultEnv() {}
}

class FakeStructured extends EventEmitter implements IStructuredManager {
  live = new Set<string>();
  spawns: string[] = [];
  spawnOpts: Record<string, StructuredSpawnOpts> = {};
  sent: Array<{ id: string; content: unknown }> = [];
  setDefaultEnv() {}
  spawn(id: string, opts: StructuredSpawnOpts) { this.live.add(id); this.spawns.push(id); this.spawnOpts[id] = opts; return 4321; }
  sendMessage(id: string, content: unknown) { this.sent.push({ id, content }); }
  answerPermission() { return false; }
  setEscalate() { return false; }
  interrupt() { return true; }
  compact() {}
  noteDeclaredStatus() {}
  getPending() { return null; }
  getSessionId() { return undefined; }
  getEvents() { return []; }
  getEventsTail() { return []; }
  isAlive(id: string) { return this.live.has(id); }
  kill(id: string) { this.live.delete(id); this.emit('exit', id, 0); }
  killAll() { this.live.clear(); }
}

let dir: string;
let home: string;
let db: Database.Database;
let svc: SessionService;
let claudeStructured: FakeStructured;
let codexStructured: FakeStructured;
const WORKDIR_PROJ = () => path.join(dir, 'proj');

/** Write a claude-transcript-shaped JSONL at the standard `~/.claude/projects/...` path, so
 *  readSessionBackfill (via resolveTranscriptPath) finds it. */
function writeClaudeTranscript(sessionId: string, workDir: string, lines: unknown[]) {
  const dirPath = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(workDir, 'darwin'));
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}

const userLine = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const assistantLine = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: text } });

function seedCoordinator(id: string, type: string, opts: { externalId?: string | null; status?: string } = {}) {
  terminalsDb.create(db, {
    id,
    sessionId: 's1',
    type,
    label: id,
    workingDir: WORKDIR_PROJ(),
    externalId: opts.externalId === undefined ? undefined : opts.externalId ?? undefined,
    config: { transport: 'structured', role: 'coordinator' },
  });
  if (opts.status) terminalsDb.updateStatus(db, id, opts.status);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-coordinator-restart-'));
  home = path.join(dir, 'home');
  fs.mkdirSync(WORKDIR_PROJ(), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: WORKDIR_PROJ() });
  svc = new SessionService(db, new FakePty() as any, path.join(dir, 'mcp.json'));
  claudeStructured = new FakeStructured();
  codexStructured = new FakeStructured();
  svc.setStructuredManager(claudeStructured);
  svc.setCodexStructuredManager(codexStructured);
  svc.setStructuredCommandOverride({ command: 'fake', args: ['--fake'] });
});

afterEach(() => {
  vi.restoreAllMocks();
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('Codex coordinator resume does not hit the claude-only readSessionBackfill path', () => {
  it('passes resumeId to the manager and carries no claude seedEvents, even when a same-named claude transcript exists on disk', () => {
    const externalId = 'codex-thread-abc';
    // A claude transcript that WOULD backfill if the type gate were removed or misfired.
    writeClaudeTranscript(externalId, WORKDIR_PROJ(), [userLine('hello'), assistantLine('hi back')]);
    seedCoordinator('cx', 'codex', { externalId });

    const alive = svc.ensureStructuredAlive('cx');

    expect(alive).toBe(true);
    expect(codexStructured.spawns).toEqual(['cx']);
    expect(codexStructured.spawnOpts['cx'].resumeId).toBe(externalId); // codex's own resume path
    expect(codexStructured.spawnOpts['cx'].seedEvents).toBeUndefined(); // NOT claude backfill
    expect(claudeStructured.spawns).toEqual([]); // never touched the claude manager
  });

  it('control case: a claude-code coordinator resume DOES receive seedEvents from the very same transcript', () => {
    const externalId = 'claude-session-abc';
    writeClaudeTranscript(externalId, WORKDIR_PROJ(), [userLine('hello'), assistantLine('hi back')]);
    seedCoordinator('cc', 'claude-code', { externalId });

    const alive = svc.ensureStructuredAlive('cc');

    expect(alive).toBe(true);
    expect(claudeStructured.spawnOpts['cc'].resumeId).toBe(externalId);
    expect(claudeStructured.spawnOpts['cc'].seedEvents).toBeDefined();
    expect((claudeStructured.spawnOpts['cc'].seedEvents as unknown[]).length).toBeGreaterThan(0);
  });
});

/** Write a Codex rollout for `threadId` under the (mocked) home, whose last turn marker is `last`. */
function writeCodexRollout(threadId: string, last: 'task_started' | 'task_complete') {
  const d = path.join(home, '.codex', 'sessions', '2026', '09', '23');
  fs.mkdirSync(d, { recursive: true });
  const ev = (type: string) => JSON.stringify({ type: 'event_msg', payload: { type } });
  const lines = [JSON.stringify({ type: 'session_meta', payload: { id: threadId } }), ev('task_started'), ev('item_completed')];
  if (last === 'task_complete') lines.push(ev('task_complete'));
  const full = path.join(d, `rollout-2026-09-23T10-00-00-${threadId}.jsonl`);
  fs.writeFileSync(full, lines.join('\n') + '\n');
  return full;
}

describe('boot kickstart covers Codex coordinators too (review T1), gated on the Codex rollout', () => {
  it('listWorkingStructured includes a stale-working Codex coordinator row alongside claude', () => {
    seedCoordinator('cx', 'codex', { externalId: 'codex-thread-1', status: 'working' });
    seedCoordinator('cc', 'claude-code', { externalId: 'claude-session-1', status: 'working' });

    const rows = terminalsDb.listWorkingStructured(db);

    expect(rows.map((r) => r.id).sort()).toEqual(['cc', 'cx']);
  });

  it('kicks a Codex coordinator whose rollout shows the turn was cut off (task_started, no task_complete)', async () => {
    writeCodexRollout('codex-thread-1', 'task_started');
    seedCoordinator('cx', 'codex', { externalId: 'codex-thread-1', status: 'working' });

    const result = await svc.kickstartInterruptedAgents(0);

    expect(result.kicked).toContain('cx');
    expect(codexStructured.spawns).toEqual(['cx']); // revived (resume) …
    expect(codexStructured.sent.map((m) => m.id)).toEqual(['cx']); // … and re-prompted
    const cfg = JSON.parse(terminalsDb.getById(db, 'cx')!.config || '{}');
    expect(typeof cfg.kickedAt).toBe('string'); // stamped, so a later boot won't double-kick
  });

  it('skips a Codex coordinator whose rollout shows the turn actually completed', async () => {
    writeCodexRollout('codex-thread-2', 'task_complete');
    seedCoordinator('cx', 'codex', { externalId: 'codex-thread-2', status: 'working' });

    const result = await svc.kickstartInterruptedAgents(0);

    expect(result.skipped).toContain('cx');
    expect(codexStructured.sent).toEqual([]);
  });

  it('does not re-kick a Codex coordinator already kicked when its rollout has not moved since', async () => {
    const file = writeCodexRollout('codex-thread-3', 'task_started');
    const past = (Date.now() - 60_000) / 1000;
    fs.utimesSync(file, past, past);
    terminalsDb.create(db, {
      id: 'cx', sessionId: 's1', type: 'codex', label: 'cx', workingDir: WORKDIR_PROJ(), externalId: 'codex-thread-3',
      config: { transport: 'structured', role: 'coordinator', kickedAt: new Date().toISOString() },
    });
    terminalsDb.updateStatus(db, 'cx', 'working');

    const result = await svc.kickstartInterruptedAgents(0);

    expect(result.skipped).toContain('cx');
    expect(codexStructured.sent).toEqual([]);
  });

  it('a stuck-working Codex coordinator still revives via ensureStructuredAlive — the revive-on-open path the design relies on', () => {
    const externalId = 'codex-thread-1';
    seedCoordinator('cx', 'codex', { externalId, status: 'working' });
    expect(codexStructured.isAlive('cx')).toBe(false); // simulates the daemon restart having killed it

    const alive = svc.ensureStructuredAlive('cx');

    expect(alive).toBe(true);
    expect(codexStructured.spawns).toEqual(['cx']);
    expect(codexStructured.spawnOpts['cx'].resumeId).toBe(externalId);
  });

  it('a stuck-working claude-code coordinator IS proactively kicked (existing behavior, unchanged)', async () => {
    seedCoordinator('cc', 'claude-code', { externalId: 'claude-session-1', status: 'working' });

    const result = await svc.kickstartInterruptedAgents(0);

    expect(result.kicked).toEqual(['cc']);
    expect(claudeStructured.sent).toHaveLength(1);
    expect(claudeStructured.sent[0].id).toBe('cc');
  });
});
