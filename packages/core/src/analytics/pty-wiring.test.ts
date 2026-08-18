import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import * as ptyDb from '../db/usage-pty.js';
import { clearTranscriptPathCache } from '../sessions/transcript-path.js';
import { encodeClaudeProjectDir } from '../platform/encode.js';
import { createApp } from '../server.js';

/**
 * Proves attachPtyCapture is actually wired into createApp — not just built and
 * left unused. Drives the real settled edge (POST /api/events, same route the
 * Claude Code Stop hook calls) rather than invoking the listener directly, so a
 * regression that forgets to call `statusService.addThreadSettledListener(...)`
 * in server.ts fails this test even though pty-capture.ts's own unit tests
 * (pty-capture.test.ts) stay green.
 */
describe('PTY capture wiring in createApp', () => {
  let db: Database.Database;
  let home: string;
  let origHome: string | undefined;
  let sessionId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    sessionId = 'sess-1';
    sessionsDb.create(db, { id: sessionId, provider: 'claude-code', name: 'x', workingDir: '' });

    origHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-wiring-'));
    process.env.HOME = home;
    clearTranscriptPathCache();
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function claudeTranscriptPath(workDir: string, id: string): string {
    return path.join(home, '.claude', 'projects', encodeClaudeProjectDir(workDir, 'darwin'), `${id}.jsonl`);
  }

  function writeClaudeTranscript(workDir: string, id: string): string {
    const file = claudeTranscriptPath(workDir, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 10, output_tokens: 5 } },
    }) + '\n');
    return file;
  }

  async function settleTurn(app: import('express').Express, terminalId: string, extId: string): Promise<void> {
    // Working edge, then the Stop hook (the real settled edge StatusService fires on).
    await request(app).post(`/api/events/claude-code/${terminalId}`).send({ hook_event_name: 'UserPromptSubmit', session_id: extId });
    await request(app).post(`/api/events/claude-code/${terminalId}`).send({ hook_event_name: 'Stop', session_id: extId });
  }

  it('a settled edge on a PTY terminal writes a usage_pty_state row', async () => {
    const workDir = path.join(home, 'proj-a');
    const extId = 'sess-a';
    const file = writeClaudeTranscript(workDir, extId);
    const termId = 'term-a';
    terminalsDb.create(db, { id: termId, sessionId, type: 'claude-code', label: 'x', externalId: extId, workingDir: workDir });

    const app = createApp({ db, skipPty: true });
    await settleTurn(app, termId, extId);

    const state = ptyDb.getState(db, termId);
    expect(state).not.toBeNull();
    expect(state!.transcript_path).toBe(file);
  });

  it('does not capture a structured terminal (the double-count gate, wired with the real predicate)', async () => {
    const workDir = path.join(home, 'proj-b');
    const extId = 'sess-b';
    writeClaudeTranscript(workDir, extId);
    const termId = 'term-b';
    // config.transport: 'structured' — createApp always registers a ClaudeStructuredSessionManager,
    // so SessionService.isStructuredTerminal must gate this terminal out.
    terminalsDb.create(db, {
      id: termId, sessionId, type: 'claude-code', label: 'x', externalId: extId, workingDir: workDir,
      config: { transport: 'structured' },
    });

    const app = createApp({ db, skipPty: true });
    await settleTurn(app, termId, extId);

    expect(ptyDb.getState(db, termId)).toBeNull();
  });
});
