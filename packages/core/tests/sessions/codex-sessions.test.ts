import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listRecentCodexSessions } from '../../src/sessions/codex-sessions.js';

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
});
