import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { transcriptTailStatus } from '../../src/sessions/cc-sessions.js';

// --- transcriptTailStatus: the boot-kickstart idempotency classifier ---------
// It reads ~/.claude/projects/<enc-workDir>/<sessionId>.jsonl, so we point HOME at
// a temp dir for this file (vitest isolates each test file in its own process).
describe('transcriptTailStatus', () => {
  const realHome = process.env.HOME;
  let home: string;
  const workDir = '/tmp/kickstart-proj';
  const projDir = () => path.join(home, '.claude', 'projects', workDir.replace(/\//g, '-'));

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kickstart-home-'));
    process.env.HOME = home;
    fs.mkdirSync(projDir(), { recursive: true });
  });
  afterAll(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
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
