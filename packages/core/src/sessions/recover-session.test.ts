import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { SessionService } from './service.js';

// getConversation resolves a claude-code terminal's transcript from
// terminal.external_id, and — when that's empty (the terminal never captured a
// session id) — falls back to recoverSessionId, which scans the project's
// ~/.claude/projects/<enc-cwd> dir. A coordinator that never ran a turn has an
// empty external_id, so this fallback decides what its Control Plane renders.
const fakePty = { isAlive: () => false, kill: () => {} } as any;

const WORKDIR = '/proj/acme';
let tmp: string;
let home: string;
let db: Database.Database;

const projectsDir = () => path.join(home, '.claude', 'projects', WORKDIR.replace(/\//g, '-'));
// Real Claude Code transcripts are newline-terminated JSONL; getConversation drops the trailing
// partial line (raw.split('\n').slice(0, -1)), so a test line MUST end in '\n' to be parsed.
const writeJsonl = (id: string, line: string) => fs.writeFileSync(path.join(projectsDir(), `${id}.jsonl`), `${line}\n`);
const userLine = (text: string, uuid: string) =>
  JSON.stringify({ type: 'user', uuid, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text } });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-recover-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(projectsDir(), { recursive: true });
  db = createDatabase(path.join(tmp, 'test.db'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  try { db.close(); } catch { /* noop */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

function coordinator(): { svc: SessionService; terminalId: string } {
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'acme', workingDir: WORKDIR });
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane' });
  const svc = new SessionService(db, fakePty, path.join(tmp, 'mcp.json'));
  return { svc, terminalId: 'coord' };
}

describe('getConversation transcript recovery for a coordinator with no external_id', () => {
  it('does NOT adopt an unrelated session when multiple transcripts exist (ambiguous → empty)', () => {
    const { svc, terminalId } = coordinator();
    // A busy project dir: the coordinator never ran (no external_id), and two UNRELATED
    // claude sessions live in the dir (e.g. the user's own terminal sessions). Picking the
    // newest would render a conversation the coordinator never owned (issue #7).
    writeJsonl('older-session', userLine('older unrelated turn', 'o1'));
    writeJsonl('newer-unrelated-session', userLine('newest unrelated turn', 'n1'));
    const conv = svc.getConversation(terminalId, { limit: 10 });
    expect(conv.items).toEqual([]); // no misattributed transcript
    // …and it must not claim someone else's session id as this terminal's identity.
    expect(terminalsDb.getById(db, terminalId)?.external_id).toBeNull();
  });

  it('still recovers + persists the session id when exactly one transcript exists (unambiguous)', () => {
    const { svc, terminalId } = coordinator();
    writeJsonl('the-only-session', userLine('the real turn', 'r1'));
    const conv = svc.getConversation(terminalId, { limit: 10 });
    expect(conv.items.map((i) => i.text)).toEqual(['the real turn']);
    expect(terminalsDb.getById(db, terminalId)?.external_id).toBe('the-only-session');
  });
});
