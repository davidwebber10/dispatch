import { describe, it, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listRecentCodexSessions, findCodexRolloutPath } from '../../src/sessions/codex-sessions.js';

function writeRollout(root: string, rel: string, lines: any[], mtimeMs?: number) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (mtimeMs) fs.utimesSync(full, mtimeMs / 1000, mtimeMs / 1000);
  return full;
}

describe('listRecentCodexSessions', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexsess-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('lists matching-cwd sessions newest-first with preview + count', async () => {
    const now = Date.now();
    writeRollout(root, '2026/06/01/rollout-a.jsonl', [
      { type: 'session_meta', payload: { session_id: 'sess-a', cwd: '/work/proj' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first task' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } },
    ], now - 60000);
    writeRollout(root, '2026/06/02/rollout-b.jsonl', [
      { type: 'session_meta', payload: { session_id: 'sess-b', cwd: '/work/proj' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second task' }] } },
    ], now);

    const list = await listRecentCodexSessions('/work/proj', 20, root);
    expect(list.map((s) => s.id)).toEqual(['sess-b', 'sess-a']);
    expect(list[0]).toMatchObject({ id: 'sess-b', preview: 'second task', messageCount: 1, truncated: false });
    expect(list[1]).toMatchObject({ id: 'sess-a', preview: 'first task', messageCount: 2 });
  });

  it('excludes sessions from other cwds', async () => {
    writeRollout(root, '2026/06/01/rollout-x.jsonl', [
      { type: 'session_meta', payload: { session_id: 'x', cwd: '/other' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } },
    ]);
    expect(await listRecentCodexSessions('/work/proj', 20, root)).toEqual([]);
  });

  it('returns [] when the sessions dir is missing', async () => {
    expect(await listRecentCodexSessions('/work/proj', 20, path.join(root, 'nope'))).toEqual([]);
  });

  it('skips a malformed file without throwing', async () => {
    fs.mkdirSync(path.join(root, '2026/06/03'), { recursive: true });
    fs.writeFileSync(path.join(root, '2026/06/03/rollout-bad.jsonl'), 'not json\n{also not');
    writeRollout(root, '2026/06/03/rollout-good.jsonl', [
      { type: 'session_meta', payload: { session_id: 'good', cwd: '/work/proj' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ok' }] } },
    ]);
    const list = await listRecentCodexSessions('/work/proj', 20, root);
    expect(list.map((s) => s.id)).toEqual(['good']);
  });

  it('falls back to a default preview when there is no user message', async () => {
    writeRollout(root, '2026/06/04/rollout-c.jsonl', [
      { type: 'session_meta', payload: { session_id: 'c', cwd: '/work/proj' } },
    ]);
    const list = await listRecentCodexSessions('/work/proj', 20, root);
    expect(list).toEqual([{ id: 'c', mtime: expect.any(Number), preview: 'New session', messageCount: 0, truncated: false }]);
  });

  it('skips a first user message starting with < and uses the next real user message', async () => {
    writeRollout(root, '2026/06/05/rollout-skip.jsonl', [
      { type: 'session_meta', payload: { session_id: 'skip', cwd: '/work/proj' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<context>blah</context>' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'real prompt' }] } },
    ]);
    const list = await listRecentCodexSessions('/work/proj', 20, root);
    expect(list[0]).toMatchObject({ id: 'skip', preview: 'real prompt' });
  });

  it('enforces the limit parameter', async () => {
    const now = Date.now();
    writeRollout(root, '2026/06/06/rollout-l1.jsonl', [
      { type: 'session_meta', payload: { session_id: 'l1', cwd: '/work/proj' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }] } },
    ], now - 1000);
    writeRollout(root, '2026/06/06/rollout-l2.jsonl', [
      { type: 'session_meta', payload: { session_id: 'l2', cwd: '/work/proj' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second' }] } },
    ], now);
    const list = await listRecentCodexSessions('/work/proj', 1, root);
    expect(list).toHaveLength(1);
  });
});

// ---- findCodexRolloutPath ----

describe('findCodexRolloutPath', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollout-'));
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const write = (rel: string, name: string) => {
    const dir = path.join(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, name);
    fs.writeFileSync(full, '');
    return full;
  };

  test('finds a rollout by its session id, wherever the date tree put it', () => {
    const want = write('2026/07/31', 'rollout-2026-07-31T00-39-59-019fb678-d13c-7d02-b46d-9d0c2533649f.jsonl');
    write('2026/07/30', 'rollout-2026-07-30T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
    expect(findCodexRolloutPath('019fb678-d13c-7d02-b46d-9d0c2533649f', root)).toBe(want);
  });

  test('returns undefined for an unknown session, and never throws on a missing root', () => {
    write('2026/07/31', 'rollout-2026-07-31T00-39-59-019fb678-d13c-7d02-b46d-9d0c2533649f.jsonl');
    expect(findCodexRolloutPath('no-such-session', root)).toBeUndefined();
    expect(findCodexRolloutPath('anything', path.join(root, 'does-not-exist'))).toBeUndefined();
    expect(findCodexRolloutPath('', root)).toBeUndefined();
  });

  // A session id must match the WHOLE trailing segment: a prefix of another id is not a hit.
  test('does not match a session id that is only a prefix of the filename id', () => {
    write('2026/07/31', 'rollout-2026-07-31T00-39-59-019fb678-d13c-7d02-b46d-9d0c2533649f.jsonl');
    expect(findCodexRolloutPath('019fb678', root)).toBeUndefined();
  });

  test('picks the newest file when a session id somehow appears twice', () => {
    write('2026/07/30', 'rollout-2026-07-30T10-00-00-dup-session.jsonl');
    const newer = write('2026/08/01', 'rollout-2026-08-01T10-00-00-dup-session.jsonl');
    expect(findCodexRolloutPath('dup-session', root)).toBe(newer);
  });
});
