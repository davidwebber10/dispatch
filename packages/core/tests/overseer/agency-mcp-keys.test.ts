import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { callTool, TOOLS, resetIdentityCache } from '../../src/overseer/agency-mcp.js';
import { httpJson } from '../../src/overseer/agency-shared.js';

const KEY = `dtk_${'A'.repeat(43)}`;
const API = 'http://localhost:9999';

type Route = (url: string, init: any) => { status?: number; body?: unknown } | undefined;

function install(routes: Route[]) {
  const calls: Array<{ url: string; init: any }> = [];
  const fetchMock = vi.fn(async (url: string, init?: any) => {
    calls.push({ url: String(url), init });
    for (const r of routes) {
      const hit = r(String(url), init);
      if (hit) {
        const status = hit.status ?? 200;
        const text = hit.body === undefined ? '' : typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body);
        return { ok: status < 400, status, statusText: status < 400 ? 'OK' : 'Error', text: async () => text };
      }
    }
    return { ok: false, status: 404, statusText: 'Not Found', text: async () => JSON.stringify({ error: 'nope' }) };
  });
  global.fetch = fetchMock as any;
  return { calls, fetchMock };
}

const whoamiRoute = (over: Record<string, unknown> = {}): Route => (url) =>
  url === `${API}/api/whoami`
    ? { body: { kind: 'thread', terminalId: 't-self', sessionId: 'sess-1', role: 'coordinator', depth: 0, spawnedBy: null, roleRun: false, overseer: false, ...over } }
    : undefined;

describe('agency-mcp sends the thread key', () => {
  const saved: Record<string, string | undefined> = {};
  const names = ['DISPATCH_API', 'DISPATCH_AUTH', 'DISPATCH_AUTH_FILE', 'DISPATCH_SESSION', 'DISPATCH_TERMINAL', 'DISPATCH_SPAWN_DEPTH', 'DISPATCH_PORT'];
  const origFetch = global.fetch;

  beforeEach(() => {
    for (const n of names) saved[n] = process.env[n];
    for (const n of names) delete process.env[n];
    process.env.DISPATCH_API = API;
    process.env.DISPATCH_AUTH = KEY;
    process.env.DISPATCH_SESSION = 'sess-1';
    process.env.DISPATCH_TERMINAL = 't-self';
    resetIdentityCache();
  });
  afterEach(() => {
    global.fetch = origFetch;
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
    vi.restoreAllMocks();
  });

  const auth = (init: any) => (init?.headers ?? {}).Authorization ?? (init?.headers ?? {}).authorization;

  it('every request carries Authorization: Bearer KEY, whoami included', async () => {
    const { calls } = install([
      whoamiRoute(),
      (u) => (u === `${API}/api/sessions/sess-1/terminals` ? { body: [{ id: 'a', label: 'A', type: 'claude-code', status: 'idle', sessionId: 'sess-1', config: { role: 'agent' } }] } : undefined),
      (u) => (u.endsWith('/permission') ? { status: 404, body: { error: 'none' } } : undefined),
      (u) => (u === `${API}/api/watches?watcher=t-self&target=t-self` ? { body: { watching: [], watchedBy: [] } } : undefined),
      (u) => (u === `${API}/api/sessions/sess-1/ledger/list` ? { body: { text: 'x', paste: 'y' } } : undefined),
    ]);
    await callTool('list_agents', {});
    await callTool('list_watches', {});
    await callTool('ledger_list', {});
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const c of calls) expect(auth(c.init)).toBe(`Bearer ${KEY}`);
    expect(calls[0].url).toBe(`${API}/api/whoami`);
  });

  it('sends no header and makes no whoami call without DISPATCH_AUTH', async () => {
    delete process.env.DISPATCH_AUTH;
    const { calls } = install([(u) => (u.endsWith('/terminals') ? { body: [] } : undefined)]);
    await callTool('list_threads', {});
    expect(calls.map((c) => c.url)).toEqual([`${API}/api/sessions/sess-1/terminals`]);
    expect(auth(calls[0].init)).toBeUndefined();
  });

  it('sends no header when DISPATCH_API is unset (port fallback)', async () => {
    delete process.env.DISPATCH_API;
    process.env.DISPATCH_PORT = '9998';
    const { calls } = install([(u) => (u.endsWith('/terminals') ? { body: [] } : undefined)]);
    await callTool('list_threads', {});
    expect(calls.map((c) => c.url)).toEqual(['http://localhost:9998/api/sessions/sess-1/terminals']);
    expect(auth(calls[0].init)).toBeUndefined();
  });

  it('httpJson sends no header to a URL outside DISPATCH_API', async () => {
    const { calls } = install([() => ({ body: { ok: true } })]);
    await httpJson('GET', 'http://other.example:9999/api/x');
    await httpJson('GET', `${API}/api/x`);
    expect(auth(calls[0].init)).toBeUndefined();
    expect(auth(calls[1].init)).toBe(`Bearer ${KEY}`);
  });

  it('a shell key is never sent by an MCP helper', async () => {
    process.env.DISPATCH_AUTH = `dsk_${'B'.repeat(43)}`;
    const { calls } = install([() => ({ body: {} })]);
    await expect(httpJson('GET', `${API}/api/x`)).rejects.toThrow(/shell key/i);
    expect(calls).toHaveLength(0);
  });

  it('a moved thread: list_threads uses the project that whoami names', async () => {
    const { calls } = install([whoamiRoute({ sessionId: 'sess-2' }), (u) => (u.endsWith('/terminals') ? { body: [] } : undefined)]);
    await callTool('list_threads', {});
    expect(calls[1].url).toBe(`${API}/api/sessions/sess-2/terminals`);
  });

  it('falls back to the env ids when whoami fails', async () => {
    const { calls } = install([(u) => (u === `${API}/api/whoami` ? { status: 401, body: { error: 'auth_required', message: 'm' } } : u.endsWith('/terminals') ? { body: [] } : undefined)]);
    const out = await callTool('list_threads', {});
    expect(out.isError).toBeUndefined();
    expect(calls[1].url).toBe(`${API}/api/sessions/sess-1/terminals`);
  });

  it('whoami is cached, and dropped after an out_of_scope answer so it runs again once', async () => {
    let whoamiCalls = 0;
    const { calls } = install([
      (u) => (u === `${API}/api/whoami` ? (whoamiCalls++, { body: { kind: 'thread', sessionId: whoamiCalls === 1 ? 'sess-1' : 'sess-9', overseer: false } }) : undefined),
      (u) => (u === `${API}/api/sessions/sess-1/terminals` ? { status: 403, body: { error: 'out_of_scope', message: 'That project is not yours.' } } : undefined),
      (u) => (u === `${API}/api/sessions/sess-9/terminals` ? { body: [] } : undefined),
    ]);
    const first = await callTool('list_threads', {});
    expect(first.isError).toBe(true);
    expect(first.content[0].text).toBe('Error: That project is not yours.');
    const second = await callTool('list_threads', {});
    expect(second.isError).toBeUndefined();
    expect(whoamiCalls).toBe(2);
    expect(calls.map((c) => c.url)).toContain(`${API}/api/sessions/sess-9/terminals`);
  });

  it('owner_only and auth_required have fixed readable texts; other codes show the daemon message', async () => {
    install([
      whoamiRoute(),
      (u) => (u.includes('/terminals/o/') ? { status: 403, body: { error: 'owner_only', message: 'raw' } } : undefined),
      (u) => (u.includes('/terminals/a/') ? { status: 401, body: { error: 'auth_required', message: 'raw' } } : undefined),
      (u) => (u.includes('/terminals/d/') ? { status: 403, body: { error: 'depth_exceeded', message: 'Too deep for you.' } } : undefined),
    ]);
    expect((await callTool('start_agent', { agentId: 'o' })).content[0].text).toBe('Error: only the owner can do this. Ask the owner to do it in the browser.');
    expect((await callTool('start_agent', { agentId: 'a' })).content[0].text).toBe("Error: this thread's Dispatch key is not valid. Ask the owner to relaunch the thread.");
    expect((await callTool('start_agent', { agentId: 'd' })).content[0].text).toBe('Error: Too deep for you.');
  });

  it('watch and ledger helpers show the key error texts too', async () => {
    install([
      whoamiRoute(),
      (u) => (u.startsWith(`${API}/api/watches`) ? { status: 403, body: { error: 'owner_only', message: 'raw' } } : undefined),
      (u) => (u.includes('/ledger') ? { status: 403, body: { error: 'out_of_scope', message: 'Not your project.' } } : undefined),
    ]);
    expect((await callTool('list_watches', {})).content[0].text).toBe('Error: only the owner can do this. Ask the owner to do it in the browser.');
    expect((await callTool('ledger_list', {})).content[0].text).toBe('Error: Not your project.');
  });

  it('complete_agent sends ?force=1 only when force is true', async () => {
    const { calls } = install([
      whoamiRoute(),
      (u, i) => (i?.method === 'DELETE' ? { status: 204 } : u.includes('/api/terminals/p1') ? { body: { id: 'p1', config: {} } } : undefined),
    ]);
    await callTool('complete_agent', { agentId: 'p1', force: true });
    expect(calls.filter((c) => c.init?.method === 'DELETE').map((c) => c.url)).toEqual([`${API}/api/terminals/p1?force=1`]);
    calls.length = 0;
    await callTool('complete_agent', { agentId: 'p1', force: false });
    expect(calls.filter((c) => c.init?.method === 'DELETE')).toHaveLength(0); // plain thread refused client side
    calls.length = 0;
    install([whoamiRoute(), (u, i) => (i?.method === 'DELETE' ? { status: 204 } : { body: { id: 'a1', config: { role: 'agent' } } })]);
    resetIdentityCache();
    const c2 = (global.fetch as any);
    await callTool('complete_agent', { agentId: 'a1' });
    const del = c2.mock.calls.find((c: any[]) => c[1]?.method === 'DELETE');
    expect(del[0]).toBe(`${API}/api/terminals/a1`);
  });

  describe('cross-project reach (overseer keys)', () => {
    const foreign = (id: string, role: string) => (u: string) =>
      u === `${API}/api/terminals/${id}` ? { body: { id, sessionId: 'sess-B', status: 'idle', config: { role } } } : undefined;
    const convo = (u: string) => (u.includes('/conversation') ? { body: { items: [{ kind: 'assistant', text: 'hello' }] } } : undefined);

    it('list_projects calls GET /api/sessions and tags the own project', async () => {
      const { calls } = install([
        whoamiRoute({ overseer: true }),
        (u) => (u === `${API}/api/sessions` ? { body: [{ id: 'sess-1', name: 'One', coordinatorId: 'c1' }, { id: 'sess-B', name: 'Bee', coordinatorId: 'c2' }] } : undefined),
      ]);
      const out = await callTool('list_projects', {});
      expect(calls[1].url).toBe(`${API}/api/sessions`);
      expect(JSON.parse(out.content[0].text)).toEqual([
        { id: 'sess-1', name: 'One', coordinatorId: 'c1', isOwn: true },
        { id: 'sess-B', name: 'Bee', coordinatorId: 'c2', isOwn: false },
      ]);
      const tool = TOOLS.find((t) => t.name === 'list_projects') as any;
      expect(tool.description).toMatch(/overseer/i);
    });

    it('list_threads with projectId reads that project, and each row has projectId', async () => {
      const { calls } = install([
        whoamiRoute({ overseer: true }),
        (u) => (u === `${API}/api/sessions/sess-B/terminals` ? { body: [{ id: 'x', label: 'X', type: 'claude-code', status: 'idle', lastActivityAt: 'now', sessionId: 'sess-B', config: {} }] } : undefined),
      ]);
      const out = await callTool('list_threads', { projectId: 'sess-B' });
      expect(calls[1].url).toBe(`${API}/api/sessions/sess-B/terminals`);
      expect(JSON.parse(out.content[0].text)[0]).toMatchObject({ id: 'x', projectId: 'sess-B' });
    });

    it('a worker passing another project gets the daemon out_of_scope message', async () => {
      install([
        whoamiRoute(),
        (u) => (u === `${API}/api/sessions/sess-B/terminals` ? { status: 403, body: { error: 'out_of_scope', message: 'Workers read their own project only.' } } : undefined),
      ]);
      const out = await callTool('list_threads', { projectId: 'sess-B' });
      expect(out.content[0].text).toBe('Error: Workers read their own project only.');
    });

    it('overseer: read_thread and read_agent on a project B id pass the client check', async () => {
      install([whoamiRoute({ overseer: true }), foreign('f1', 'agent'), convo, (u) => (u.endsWith('/permission') ? { status: 404 } : undefined)]);
      const t = await callTool('read_thread', { id: 'f1' });
      expect(t.isError).toBeUndefined();
      expect(JSON.parse(t.content[0].text).output).toBe('hello');
      const a = await callTool('read_agent', { agentId: 'f1' });
      expect(a.isError).toBeUndefined();
    });

    it('non-overseer: read_thread and read_agent on a project B id are refused with no conversation fetch', async () => {
      const { calls } = install([whoamiRoute({ overseer: false }), foreign('f1', 'agent'), convo]);
      const t = await callTool('read_thread', { id: 'f1' });
      expect(t.content[0].text).toBe('Error: f1 is not a thread in this project');
      const a = await callTool('read_agent', { agentId: 'f1' });
      expect(a.content[0].text).toBe('Error: f1 is not a thread in this project');
      expect(calls.some((c) => c.url.includes('/conversation'))).toBe(false);
    });

    it('overseer: message_thread to project B coordinator passes; to a project B worker is refused with no POST', async () => {
      const { calls } = install([
        whoamiRoute({ overseer: true }), foreign('co', 'coordinator'), foreign('wk', 'agent'),
        (u, i) => (i?.method === 'POST' ? { status: 204 } : undefined),
      ]);
      const ok = await callTool('message_thread', { id: 'co', text: 'hi' });
      expect(ok.isError).toBeUndefined();
      expect(calls.some((c) => c.init?.method === 'POST' && c.url === `${API}/api/terminals/co/message`)).toBe(true);
      const bad = await callTool('message_thread', { id: 'wk', text: 'hi' });
      expect(bad.content[0].text).toBe("Error: outside your project you can only message another project's overseer.");
      expect(calls.some((c) => c.url === `${API}/api/terminals/wk/message`)).toBe(false);
    });

    it('non-overseer: message_thread to project B coordinator is refused with no POST', async () => {
      const { calls } = install([whoamiRoute({ overseer: false }), foreign('co', 'coordinator'), (u, i) => (i?.method === 'POST' ? { status: 204 } : undefined)]);
      const out = await callTool('message_thread', { id: 'co', text: 'hi' });
      expect(out.isError).toBe(true);
      expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
    });

    it('assertReadable shows a 403 as itself, not as not in this project', async () => {
      install([whoamiRoute({ overseer: true }), (u) => (u === `${API}/api/terminals/f1` ? { status: 403, body: { error: 'out_of_scope', message: 'Daemon says no.' } } : undefined)]);
      const out = await callTool('read_thread', { id: 'f1' });
      expect(out.content[0].text).toBe('Error: Daemon says no.');
    });

    it('descriptions name the overseer reach', () => {
      for (const n of ['list_threads', 'read_thread', 'message_thread']) {
        const d = (TOOLS.find((t) => t.name === n) as any).description as string;
        expect(d).toContain('Overseers (project coordinators) can also use this on other projects: read any thread, and message only another project\'s overseer.');
        expect(d).toContain("Messages you receive from another project's overseer start with a line that names its project.");
      }
    });
  });
});
