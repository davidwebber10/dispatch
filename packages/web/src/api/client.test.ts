import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { api } from './client';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

function mockJson(body: unknown, status = 200) {
  (fetch as any).mockResolvedValueOnce({ ok: status < 400, status, json: async () => body });
}

test('listSessions GETs /api/sessions and returns the array', async () => {
  mockJson([{ id: 's1', name: 'demo' }]);
  const sessions = await api.listSessions();
  expect(fetch).toHaveBeenCalledWith('/api/sessions', expect.objectContaining({ method: 'GET' }));
  expect(sessions[0].id).toBe('s1');
});

test('createTerminal POSTs JSON to the session terminals route', async () => {
  mockJson({ id: 't1', sessionId: 's1', type: 'claude-code' });
  const t = await api.createTerminal('s1', { type: 'claude-code' });
  expect(fetch).toHaveBeenCalledWith('/api/sessions/s1/terminals', expect.objectContaining({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'claude-code' }),
  }));
  expect(t.id).toBe('t1');
});

test('archiveTerminal issues DELETE and resolves void on 204', async () => {
  (fetch as any).mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) });
  await expect(api.archiveTerminal('t1')).resolves.toBeUndefined();
  expect(fetch).toHaveBeenCalledWith('/api/terminals/t1', expect.objectContaining({ method: 'DELETE' }));
});

test('throws on non-ok responses', async () => {
  mockJson({ error: 'boom' }, 500);
  await expect(api.listSessions()).rejects.toThrow(/500/);
});

test('writeFile PUTs content to the sandboxed write route', async () => {
  mockJson({ ok: true, path: 'a.txt' });
  await api.writeFile('s1', 'a.txt', 'hello');
  expect(fetch).toHaveBeenCalledWith('/api/sessions/s1/files/write?path=a.txt', expect.objectContaining({
    method: 'PUT', body: JSON.stringify({ content: 'hello' }),
  }));
});

test('forwardAuthCallback POSTs the loopback url to the callback route', async () => {
  mockJson({ id: 'a1', status: 'callback_forwarded' });
  await api.forwardAuthCallback('a1', 'http://localhost:9999/cb?code=x');
  expect(fetch).toHaveBeenCalledWith('/api/auth-requests/a1/callback', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ url: 'http://localhost:9999/cb?code=x' }),
  }));
});

test('sendFileReference defaults to agent-context mode', async () => {
  mockJson({ ok: true, sentText: 'Use this file...' });
  await api.sendFileReference('t1', '.dispatch/inbox/x.png');
  expect(fetch).toHaveBeenCalledWith('/api/terminals/t1/send-file-reference', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ path: '.dispatch/inbox/x.png', mode: 'agent-context' }),
  }));
});

test('getScrollbackSize GETs the scrollback route and returns totalBytes', async () => {
  mockJson({ totalBytes: 4_123_456 });
  const size = await api.getScrollbackSize('t1');
  expect(fetch).toHaveBeenCalledWith('/api/terminals/t1/scrollback', expect.objectContaining({ method: 'GET' }));
  expect(size).toBe(4_123_456);
});

test('getScrollbackSize rejects on a 404 (unknown terminal), same as other terminal routes', async () => {
  mockJson({ error: 'Terminal not found' }, 404);
  await expect(api.getScrollbackSize('missing')).rejects.toThrow(/404/);
});
