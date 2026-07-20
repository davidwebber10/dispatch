import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveTranscriptPath, clearTranscriptPathCache } from '../../src/sessions/transcript-path.js';

/**
 * Regression coverage for threads whose chat rendered completely empty while the same
 * thread's PTY scrollback was fine: PTY replays its own buffer, but the chat is rebuilt from
 * the Claude Code transcript, and we were computing exactly one path for it and giving up if
 * nothing was there.
 *
 * Two independent ways that path went wrong, both observed locally:
 *  - the working dir contains characters the encoder mishandled (see platform/encode.ts);
 *  - the session RELOCATED. `EnterWorktree` (and any cwd change) makes Claude Code continue
 *    the same session id under a DIFFERENT project directory, while Dispatch's stored
 *    `working_dir` stays at whatever it was when the thread spawned.
 */

const SID = 'd9fb101f-d1ab-4b7b-a371-825cad59b243';
let root: string;

function writeTranscript(dirName: string, sessionId: string, body = '{"type":"user"}\n') {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(p, body);
  return p;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-transcript-'));
  clearTranscriptPathCache();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  clearTranscriptPathCache();
});

describe('resolveTranscriptPath', () => {
  test('finds the transcript at the encoded working dir (the common case)', () => {
    const expected = writeTranscript('-Users-dw-Sites-dispatch', SID);
    expect(resolveTranscriptPath('/Users/dw/Sites/dispatch', SID, root)).toBe(expected);
  });

  test('finds a transcript under a dot-directory working dir', () => {
    // `/.claude` encodes to `--claude`; the old `/`-only rule looked for `-.claude`.
    const expected = writeTranscript('-Users-dw-Sites-dispatch--claude-worktrees-status-truth', SID);
    expect(resolveTranscriptPath('/Users/dw/Sites/dispatch/.claude/worktrees/status-truth', SID, root)).toBe(expected);
  });

  test('finds a RELOCATED transcript that no longer lives under its working dir', () => {
    // The reported bug, exactly: the thread's stored working_dir is the main repo, but the
    // session moved into a worktree, so Claude Code writes under the worktree's project dir.
    // Nothing exists at the computed path — resolution must search by session id.
    const expected = writeTranscript('-Users-dw-Sites-dispatch--claude-worktrees-status-truth', SID);
    fs.mkdirSync(path.join(root, '-Users-dw-Sites-dispatch'), { recursive: true }); // exists but empty
    expect(resolveTranscriptPath('/Users/dw/Sites/dispatch', SID, root)).toBe(expected);
  });

  test('returns undefined when the session has no transcript anywhere', () => {
    writeTranscript('-Users-dw-Sites-dispatch', 'some-other-session');
    expect(resolveTranscriptPath('/Users/dw/Sites/dispatch', SID, root)).toBeUndefined();
  });

  test('never returns another session\'s transcript', () => {
    writeTranscript('-Users-dw-elsewhere', 'not-the-one');
    expect(resolveTranscriptPath('/Users/dw/Sites/dispatch', SID, root)).toBeUndefined();
  });

  test('prefers the working dir over a search hit when BOTH exist', () => {
    // A relocated session can leave a same-id file in more than one project dir. The one
    // under the thread's own working dir is the authoritative choice.
    const expected = writeTranscript('-Users-dw-Sites-dispatch', SID);
    writeTranscript('-Users-dw-somewhere-else', SID);
    expect(resolveTranscriptPath('/Users/dw/Sites/dispatch', SID, root)).toBe(expected);
  });

  test('a cached resolution does not go stale when the file is removed', () => {
    // Resolution is memoized (the search scans every project dir), so a cache hit must be
    // revalidated — otherwise a deleted/rotated transcript would be served forever.
    const p = writeTranscript('-Users-dw-Sites-dispatch', SID);
    expect(resolveTranscriptPath('/Users/dw/Sites/dispatch', SID, root)).toBe(p);
    fs.rmSync(p);
    expect(resolveTranscriptPath('/Users/dw/Sites/dispatch', SID, root)).toBeUndefined();
  });

  test('a relocated session resolves again after the search result is cached', () => {
    const expected = writeTranscript('-Users-dw-worktree', SID);
    expect(resolveTranscriptPath('/Users/dw/Sites/dispatch', SID, root)).toBe(expected);
    expect(resolveTranscriptPath('/Users/dw/Sites/dispatch', SID, root)).toBe(expected);
  });

  test('tolerates a missing projects root without throwing', () => {
    expect(resolveTranscriptPath('/Users/dw/x', SID, path.join(root, 'nope'))).toBeUndefined();
  });
});
