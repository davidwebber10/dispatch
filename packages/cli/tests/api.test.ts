import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCommand } from '../src/index.js';

const THREAD_KEY = `dtk_${'T'.repeat(43)}`;
const SHELL_KEY = `dsk_${'S'.repeat(43)}`;
const API = 'http://127.0.0.1:3456';

let out: string[];
let tmp: string;
beforeEach(() => {
  out = [];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-api-'));
  // The test may run inside a Dispatch thread: start from a clean thread environment.
  for (const n of ['DISPATCH_AUTH', 'DISPATCH_AUTH_FILE', 'DISPATCH_TERMINAL_ID', 'DISPATCH_TERMINAL', 'DISPATCH_API']) vi.stubEnv(n, '');
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const res = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => body,
});

function ctxOf(over: Record<string, unknown> = {}) {
  const readOwnerToken = vi.fn(() => 'owner-tok');
  const apiFetch = vi.fn(async (_url: string, _init?: RequestInit) => res(200, { ok: true }));
  return { ctx: { daemon: {} as any, port: 3456, processEnv: {}, readOwnerToken, apiFetch, rolesFetch: apiFetch, ...over } as any, readOwnerToken, apiFetch };
}
const headerOf = (fn: ReturnType<typeof vi.fn>, k = 0) => ((fn.mock.calls[k][1] as RequestInit | undefined)?.headers ?? {}) as Record<string, string>;

describe('dispatch roles sends a credential', () => {
  test('the owner token goes in a header, never in argv', async () => {
    const { ctx, apiFetch } = ctxOf({ rolesFetch: undefined });
    const rolesFetch = vi.fn(async () => res(200, { roles: [] }));
    await runCommand(['roles', 'list'], { ...ctx, rolesFetch });
    expect(headerOf(rolesFetch as any).Authorization).toBe('Bearer owner-tok');
    expect(JSON.stringify(process.argv)).not.toContain('owner-tok');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  test('inside a thread the key is sent, and the owner token is never read', async () => {
    const readOwnerToken = vi.fn(() => { throw new Error('must not read the owner token'); });
    const rolesFetch = vi.fn(async () => res(200, { roles: [] }));
    await runCommand(['roles', 'list'], { daemon: {} as any, port: 3456, readOwnerToken, rolesFetch, processEnv: { DISPATCH_AUTH: THREAD_KEY, DISPATCH_API: API } } as any);
    expect(headerOf(rolesFetch as any).Authorization).toBe(`Bearer ${THREAD_KEY}`);
    expect(readOwnerToken).not.toHaveBeenCalled();
  });

  test('a thread key with no DISPATCH_API is refused before any request (destination rule)', async () => {
    const readOwnerToken = vi.fn(() => 'owner-tok');
    const rolesFetch = vi.fn(async () => res(200, { roles: [] }));
    await expect(runCommand(['roles', 'list'], { daemon: {} as any, port: 3456, readOwnerToken, rolesFetch, processEnv: { DISPATCH_AUTH: THREAD_KEY } } as any)).rejects.toThrow(/DISPATCH_API/);
    expect(rolesFetch).not.toHaveBeenCalled();
    expect(readOwnerToken).not.toHaveBeenCalled();
  });

  test('roles in a thread use the DISPATCH_API origin and base path', async () => {
    const rolesFetch = vi.fn(async (_u: string, _i?: RequestInit) => res(200, { roles: [] }));
    await runCommand(['roles', 'list'], { daemon: {} as any, port: 3456, readOwnerToken: () => 'o', rolesFetch, processEnv: { DISPATCH_AUTH: THREAD_KEY, DISPATCH_API: `${API}/base` } } as any);
    expect(rolesFetch.mock.calls[0][0]).toBe(`${API}/base/api/roles`);
    expect(headerOf(rolesFetch as any).Authorization).toBe(`Bearer ${THREAD_KEY}`);
  });

  test('an unreadable key file never falls back to the owner token', async () => {
    const readOwnerToken = vi.fn(() => 'owner-tok');
    const rolesFetch = vi.fn(async () => res(200, { roles: [] }));
    await expect(runCommand(['roles', 'list'], {
      daemon: {} as any, port: 3456, readOwnerToken, rolesFetch,
      processEnv: { DISPATCH_AUTH_FILE: path.join(tmp, 'missing'), DISPATCH_API: API },
    } as any)).rejects.toThrow(/no Dispatch key/);
    expect(rolesFetch).not.toHaveBeenCalled();
    expect(readOwnerToken).not.toHaveBeenCalled();
  });

  test('a shell key keeps owner mode', async () => {
    const rolesFetch = vi.fn(async () => res(200, { roles: [] }));
    await runCommand(['roles', 'list'], { daemon: {} as any, port: 3456, readOwnerToken: () => 'owner-tok', rolesFetch, processEnv: { DISPATCH_AUTH: SHELL_KEY, DISPATCH_TERMINAL_ID: 't1' } } as any);
    expect(headerOf(rolesFetch as any).Authorization).toBe('Bearer owner-tok');
  });

  test('with no owner token file and no thread, nothing is sent', async () => {
    const rolesFetch = vi.fn(async () => res(200, { roles: [] }));
    await runCommand(['roles', 'list'], { daemon: {} as any, port: 3456, readOwnerToken: () => null, rolesFetch, processEnv: {} } as any);
    expect(headerOf(rolesFetch as any).Authorization).toBeUndefined();
  });
});

describe('dispatch access in thread mode', () => {
  const access = () => ({ ensureAccessToken: vi.fn(() => 'tok-1'), rotateAccessToken: vi.fn(), createAccessConfig: vi.fn() });
  const MSG = 'Run this in your own terminal, not in a Dispatch thread.';
  test.each([
    ['a dtk_ key', { DISPATCH_AUTH: THREAD_KEY }],
    ['a key file', { DISPATCH_AUTH_FILE: '/some/file' }],
    ['only a thread marker', { DISPATCH_TERMINAL_ID: 't1' }],
  ])('refuses with %s', async (_n, env) => {
    const a = access();
    await expect(Promise.resolve(runCommand(['access'], { daemon: {} as any, port: 3456, dataDir: tmp, accessLib: a, processEnv: env } as any))).rejects.toThrow(MSG);
    expect(a.ensureAccessToken).not.toHaveBeenCalled();
    expect(out.join('\n')).not.toContain('tok-1');
  });
  test('a dsk_ key keeps owner mode', async () => {
    const a = access();
    await runCommand(['access'], { daemon: {} as any, port: 3456, dataDir: tmp, accessLib: a, processEnv: { DISPATCH_AUTH: SHELL_KEY, DISPATCH_TERMINAL_ID: 't1' } } as any);
    expect(a.ensureAccessToken).toHaveBeenCalled();
  });
});

describe('dispatch api', () => {
  test('GET prints the answer and sends the owner token', async () => {
    const { ctx, apiFetch } = ctxOf();
    apiFetch.mockResolvedValueOnce(res(200, { sessions: [1, 2] }));
    await runCommand(['api', 'GET', '/api/sessions'], ctx);
    expect(apiFetch.mock.calls[0][0]).toBe('http://localhost:3456/api/sessions');
    expect((apiFetch.mock.calls[0][1] as RequestInit).method).toBe('GET');
    expect(headerOf(apiFetch as any).Authorization).toBe('Bearer owner-tok');
    expect(JSON.parse(out.join('\n'))).toEqual({ sessions: [1, 2] });
  });

  test('--body FILE sends the file content as JSON', async () => {
    const { ctx, apiFetch } = ctxOf();
    const f = path.join(tmp, 'body.json');
    fs.writeFileSync(f, '{"a":1}');
    await runCommand(['api', 'POST', '/api/thing', '--body', f], ctx);
    const init = apiFetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(headerOf(apiFetch as any)['Content-Type'] ?? headerOf(apiFetch as any)['content-type']).toBe('application/json');
  });

  test('--body - reads stdin', async () => {
    const { ctx, apiFetch } = ctxOf({ readStdin: () => '{"b":2}' });
    await runCommand(['api', 'POST', '/api/thing', '--body', '-'], ctx);
    expect((apiFetch.mock.calls[0][1] as RequestInit).body).toBe('{"b":2}');
  });

  test('a non-2xx answer prints the body and fails', async () => {
    const { ctx, apiFetch } = ctxOf();
    apiFetch.mockResolvedValueOnce(res(403, { error: 'owner_only', message: 'no' }));
    await expect(runCommand(['api', 'GET', '/api/x'], ctx)).rejects.toThrow(/HTTP 403/);
    expect(JSON.parse(out.join('\n'))).toEqual({ error: 'owner_only', message: 'no' });
  });

  test('inside a thread it sends the thread key', async () => {
    const { ctx, apiFetch } = ctxOf({ processEnv: { DISPATCH_AUTH: THREAD_KEY, DISPATCH_API: API } });
    await runCommand(['api', 'GET', '/api/whoami'], ctx);
    expect(headerOf(apiFetch as any).Authorization).toBe(`Bearer ${THREAD_KEY}`);
  });

  test('in a thread the URL comes from DISPATCH_API (127.0.0.1, with a base path)', async () => {
    const a = ctxOf({ processEnv: { DISPATCH_AUTH: THREAD_KEY, DISPATCH_API: API } });
    await runCommand(['api', 'GET', '/api/whoami'], a.ctx);
    expect(a.apiFetch.mock.calls[0][0]).toBe('http://127.0.0.1:3456/api/whoami');
    expect(headerOf(a.apiFetch as any).Authorization).toBe(`Bearer ${THREAD_KEY}`);
    const b = ctxOf({ processEnv: { DISPATCH_AUTH: THREAD_KEY, DISPATCH_API: `${API}/base/` } });
    await runCommand(['api', 'GET', '/api/whoami'], b.ctx);
    expect(b.apiFetch.mock.calls[0][0]).toBe('http://127.0.0.1:3456/base/api/whoami');
    expect(headerOf(b.apiFetch as any).Authorization).toBe(`Bearer ${THREAD_KEY}`);
  });

  test('in a thread with no usable DISPATCH_API it refuses and sends nothing', async () => {
    for (const api of [undefined, 'not a url']) {
      const { ctx, apiFetch } = ctxOf({ processEnv: { DISPATCH_AUTH: THREAD_KEY, ...(api ? { DISPATCH_API: api } : {}) } });
      await expect(runCommand(['api', 'GET', '/api/whoami'], ctx)).rejects.toThrow(/DISPATCH_API/);
      expect(apiFetch).not.toHaveBeenCalled();
    }
  });

  test('in a thread a PORT that names another daemon is refused; the same port or none is fine', async () => {
    const env = { DISPATCH_AUTH: THREAD_KEY, DISPATCH_API: API };
    const other = ctxOf({ processEnv: { ...env, PORT: '4000' } });
    await expect(runCommand(['api', 'GET', '/api/whoami'], other.ctx)).rejects.toThrow(/PORT names another daemon; this thread key goes only to DISPATCH_API/);
    expect(other.apiFetch).not.toHaveBeenCalled();
    for (const processEnv of [{ ...env, PORT: '3456' }, env]) {
      const ok = ctxOf({ processEnv });
      await runCommand(['api', 'GET', '/api/whoami'], ok.ctx);
      expect(ok.apiFetch.mock.calls[0][0]).toBe('http://127.0.0.1:3456/api/whoami');
    }
  });

  test('outside a thread the owner goes to ctx.port, whatever PORT says', async () => {
    const { ctx, apiFetch } = ctxOf({ processEnv: { PORT: '4000' } });
    await runCommand(['api', 'GET', '/api/x'], ctx);
    expect(apiFetch.mock.calls[0][0]).toBe('http://localhost:3456/api/x');
  });

  test('an unreadable key file fails before any request', async () => {
    const { ctx, apiFetch, readOwnerToken } = ctxOf({ processEnv: { DISPATCH_AUTH_FILE: path.join(tmp, 'nope'), DISPATCH_API: API } });
    await expect(runCommand(['api', 'GET', '/api/x'], ctx)).rejects.toThrow(/no Dispatch key/);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(readOwnerToken).not.toHaveBeenCalled();
  });

  test('usage errors: method, path, full URL, missing body file', async () => {
    const { ctx, apiFetch } = ctxOf();
    await expect(runCommand(['api'], ctx)).rejects.toThrow(/usage/);
    await expect(runCommand(['api', 'FETCH', '/api/x'], ctx)).rejects.toThrow(/usage/);
    await expect(runCommand(['api', 'GET', 'http://evil.example/api/x'], ctx)).rejects.toThrow(/usage/);
    await expect(runCommand(['api', 'GET', 'api/x'], ctx)).rejects.toThrow(/usage/);
    await expect(runCommand(['api', 'POST', '/api/x', '--body'], ctx)).rejects.toThrow(/usage/);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  test('a refused connection says the daemon is not running', async () => {
    const { ctx, apiFetch } = ctxOf();
    apiFetch.mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    await expect(runCommand(['api', 'GET', '/api/x'], ctx)).rejects.toThrow(/daemon not running/);
  });
});

describe('dispatch status counts', () => {
  const daemon = { status: () => ({ loaded: true, pid: 1 }) } as any;
  const stats = { since: 1, browser: { total: 12, top: [{ pattern: 'GET /api/sessions', count: 9 }] }, program: { total: 3, top: [{ pattern: 'POST /api/auth-requests', count: 3 }] } };

  test('prints the no-credential counts when the daemon answers', async () => {
    const { ctx, apiFetch } = ctxOf({ daemon, probe: () => true });
    apiFetch.mockResolvedValueOnce(res(200, stats));
    await runCommand(['status'], ctx);
    expect(apiFetch.mock.calls[0][0]).toBe('http://localhost:3456/api/access/no-credential-stats');
    expect(headerOf(apiFetch as any).Authorization).toBe('Bearer owner-tok');
    const text = out.join('\n');
    expect(text).toMatch(/browser 12/);
    expect(text).toMatch(/program 3/);
    expect(text).toContain('POST /api/auth-requests');
  });

  test('prints nothing extra, and makes no request, when the daemon is down or this is a thread', async () => {
    const down = ctxOf({ daemon, probe: () => false });
    await runCommand(['status'], down.ctx);
    expect(down.apiFetch).not.toHaveBeenCalled();
    const thread = ctxOf({ daemon, probe: () => true, processEnv: { DISPATCH_AUTH: THREAD_KEY, DISPATCH_API: API } });
    await runCommand(['status'], thread.ctx);
    expect(thread.apiFetch).not.toHaveBeenCalled();
  });

  test('a failed stats call never breaks status', async () => {
    const { ctx, apiFetch } = ctxOf({ daemon, probe: () => true });
    apiFetch.mockRejectedValueOnce(new Error('boom'));
    await expect(Promise.resolve(runCommand(['status'], ctx))).resolves.toBeUndefined();
  });
});
