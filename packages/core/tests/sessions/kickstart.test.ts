import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { transcriptTailScheduled, transcriptTailStatus } from '../../src/sessions/cc-sessions.js';

// --- transcriptTailStatus: the boot-kickstart idempotency classifier ---------
// It reads ~/.claude/projects/<enc-workDir>/<sessionId>.jsonl, so we point HOME at
// a temp dir for this file (vitest isolates each test file in its own process).
describe('transcriptTailStatus', () => {
  const realHome = process.env.HOME;
  const realUserProfile = process.env.USERPROFILE;
  let home: string;
  const workDir = '/tmp/kickstart-proj';
  const projDir = () => path.join(home, '.claude', 'projects', workDir.replace(/\//g, '-'));

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kickstart-home-'));
    process.env.HOME = home;
    // On Windows os.homedir() reads USERPROFILE (not HOME); set both so the
    // product code resolves to the same temp dir on every platform.
    process.env.USERPROFILE = home;
    fs.mkdirSync(projDir(), { recursive: true });
  });
  afterAll(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realUserProfile;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeTranscript(id: string, lines: unknown[]): void {
    fs.writeFileSync(path.join(projDir(), `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
  }

  it('reports completed=true when the tail is a text-only assistant turn', () => {
    writeTranscript('done', [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do it' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'all finished' }] } },
    ]);
    const s = transcriptTailStatus(workDir, 'done');
    expect(s).not.toBeNull();
    expect(s!.completed).toBe(true);
    expect(s!.mtimeMs).toBeGreaterThan(0);
  });

  it('reports completed=false when the tail is an assistant message with a dangling tool_use', () => {
    writeTranscript('mid-tool', [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do it' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'running' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
    ]);
    expect(transcriptTailStatus(workDir, 'mid-tool')!.completed).toBe(false);
  });

  it('reports completed=false when the tail is a user tool_result the model never answered', () => {
    writeTranscript('mid-turn', [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    ]);
    expect(transcriptTailStatus(workDir, 'mid-turn')!.completed).toBe(false);
  });

  it('ignores trailing sidechain/meta noise when finding the last real turn', () => {
    writeTranscript('noise', [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do it' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', id: 's', name: 'X', input: {} }] } },
      { type: 'user', isMeta: true, message: { role: 'user', content: 'injected' } },
    ]);
    // the sidechain tool_use + meta line are skipped → last real turn is the completed assistant text
    expect(transcriptTailStatus(workDir, 'noise')!.completed).toBe(true);
  });

  it('returns null when the transcript file is missing', () => {
    expect(transcriptTailStatus(workDir, 'no-such-session')).toBeNull();
  });
});

// --- transcriptTailScheduled: the boot-recovery backstop for a dormant wake-scheduler turn ---
// Sibling to transcriptTailStatus above: a transcript that LOOKS interrupted (completed=false,
// a dangling tool_use) may actually be a thread that deliberately went dormant on
// ScheduleWakeup/CronCreate — this disambiguates that case. Shares the same temp-HOME setup.
describe('transcriptTailScheduled', () => {
  const realHome = process.env.HOME;
  const realUserProfile = process.env.USERPROFILE;
  let home: string;
  const workDir = '/tmp/kickstart-scheduled-proj';
  const projDir = () => path.join(home, '.claude', 'projects', workDir.replace(/\//g, '-'));

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kickstart-scheduled-home-'));
    process.env.HOME = home;
    // On Windows os.homedir() reads USERPROFILE (not HOME); set both so the
    // product code resolves to the same temp dir on every platform.
    process.env.USERPROFILE = home;
    fs.mkdirSync(projDir(), { recursive: true });
  });
  afterAll(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realUserProfile;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeTranscript(id: string, lines: unknown[]): void {
    fs.writeFileSync(path.join(projDir(), `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
  }

  it("is true when the last assistant turn's final tool_use is ScheduleWakeup", () => {
    writeTranscript('wake', [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
      { type: 'assistant', message: { content: [
        { type: 'text', text: 'ok, scheduling a check-in' },
        { type: 'tool_use', id: 'x1', name: 'ScheduleWakeup', input: { delaySeconds: 60, reason: 'watch CI', prompt: 'continue' } },
      ] } },
    ]);
    expect(transcriptTailScheduled(workDir, 'wake')).toBe(true);
    // Same transcript reads completed=false via the plain classifier — that ambiguity
    // (dormant vs. genuinely stuck) is exactly what this backstop resolves.
    expect(transcriptTailStatus(workDir, 'wake')!.completed).toBe(false);
  });

  it('is true for CronCreate too (no `reason` field on that tool, still a wake tool)', () => {
    writeTranscript('cron', [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x1', name: 'CronCreate', input: { cron: '*/5 * * * *', prompt: 'poll' } }] } },
    ]);
    expect(transcriptTailScheduled(workDir, 'cron')).toBe(true);
  });

  it('is false when the last tool_use is an ordinary tool — a genuinely stuck/dangling turn', () => {
    writeTranscript('stuck', [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'ls' } }] } },
    ]);
    expect(transcriptTailScheduled(workDir, 'stuck')).toBe(false);
  });

  it('checks only the LAST tool_use in a multi-tool-call turn', () => {
    writeTranscript('multi', [
      { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'x1', name: 'ScheduleWakeup', input: { delaySeconds: 60, reason: 'r', prompt: 'p' } },
        { type: 'tool_use', id: 'x2', name: 'Bash', input: { command: 'ls' } },
      ] } },
    ]);
    // Bash was the LAST call this turn, not ScheduleWakeup — genuinely dangling.
    expect(transcriptTailScheduled(workDir, 'multi')).toBe(false);
  });

  it('is false when the last turn completed cleanly (no dangling tool_use)', () => {
    writeTranscript('clean', [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'all done' }] } },
    ]);
    expect(transcriptTailScheduled(workDir, 'clean')).toBe(false);
  });

  it('is false (not throwing) when the transcript is missing', () => {
    expect(transcriptTailScheduled(workDir, 'no-such-session')).toBe(false);
  });
});

// --- listWorkingStructured: the cross-session enumeration ---------------------
describe('listWorkingStructured', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    for (const sid of ['s1', 's2']) {
      sessionsDb.create(db, { id: sid, provider: 'claude-code', name: sid, workingDir: '/tmp' });
    }
  });

  function mkTerminal(id: string, sessionId: string, status: string, opts: { archived?: boolean; type?: string } = {}): void {
    terminalsDb.create(db, { id, sessionId, type: opts.type ?? 'claude-code', label: id });
    terminalsDb.updateStatus(db, id, status);
    if (opts.archived) terminalsDb.archive(db, id);
  }

  it('returns only non-archived claude-code terminals in status=working, across sessions', () => {
    mkTerminal('a', 's1', 'working');
    mkTerminal('b', 's2', 'working');          // a different session — still included
    mkTerminal('c', 's1', 'waiting');          // not working
    mkTerminal('d', 's1', 'needs_input');      // not working (the deferred case)
    mkTerminal('e', 's1', 'working', { archived: true }); // archived
    mkTerminal('f', 's1', 'working', { type: 'shell' });  // not claude-code

    const ids = terminalsDb.listWorkingStructured(db).map((r) => r.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });
});
