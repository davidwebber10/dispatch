import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { locateCodexTranscript } from './codex-locate.js';

describe('locateCodexTranscript', () => {
  let root: string, sessions: string, archived: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loc-'));
    sessions = path.join(root, 'sessions');
    archived = path.join(root, 'archived_sessions');
    fs.mkdirSync(path.join(sessions, '2026', '08', '13'), { recursive: true });
    fs.mkdirSync(path.join(sessions, '2026', '08', '14'), { recursive: true });
    fs.mkdirSync(archived, { recursive: true });
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const roots = () => ({ sessions, archived });

  it('finds a transcript by its id regardless of which date bucket holds it', () => {
    const f = path.join(sessions, '2026', '08', '13', 'rollout-2026-08-13T22-10-00-abc123.jsonl');
    fs.writeFileSync(f, '');
    expect(locateCodexTranscript('abc123', roots())).toBe(f);
  });

  // The real gotcha: the bucket is LOCAL time, the database timestamp is UTC. A
  // locator that computed one bucket from created_at would miss this file entirely.
  it('finds a file whose bucket does not match its UTC date', () => {
    const f = path.join(sessions, '2026', '08', '14', 'rollout-2026-08-14T01-30-00-lateNight.jsonl');
    fs.writeFileSync(f, '');
    expect(locateCodexTranscript('lateNight', roots())).toBe(f);
  });

  it('falls back to archived sessions', () => {
    const f = path.join(archived, 'rollout-2026-07-01T09-00-00-oldId.jsonl');
    fs.writeFileSync(f, '');
    expect(locateCodexTranscript('oldId', roots())).toBe(f);
  });

  it('returns undefined for an unknown id and for an empty id', () => {
    expect(locateCodexTranscript('missing', roots())).toBeUndefined();
    expect(locateCodexTranscript('', roots())).toBeUndefined();
  });

  it('does not throw when the roots do not exist', () => {
    expect(locateCodexTranscript('x', { sessions: '/nope/a', archived: '/nope/b' })).toBeUndefined();
  });
});
