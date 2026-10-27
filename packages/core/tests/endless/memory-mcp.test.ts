import { describe, it, expect, vi, afterEach } from 'vitest';
import { callTool, handleRequest, TOOLS } from '../../src/endless/memory-mcp.js';
import { CARD_FIELDS_SCHEMA } from '../../src/overseer/agency-shared.js';

afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('memory MCP server', () => {
  it('lists the stage-1 tools, then the thread and ledger tools, as fixed text', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((res!.result as any).tools.map((t: any) => t.name)).toEqual([
      'zoom', 'date', 'list_threads', 'read_thread',
      'spawn_agent', 'message_thread', 'read_agent',
      'ledger_list', 'ledger_show', 'ledger_add', 'ledger_resolve', 'ledger_set_title',
    ]);
    expect(TOOLS[0].description).toBe('Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.');
    expect(TOOLS[1].description).toBe('The date and time of message id.');
    const all = JSON.stringify(TOOLS);
    expect(all).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(all).not.toContain('DISPATCH_SESSION');
    for (const t of TOOLS) {
      if (t.name === 'spawn_agent' || t.name.startsWith('ledger_')) expect((t.inputSchema as any).required).toContain('project');
    }
  });

  it('zoom returns text and image content blocks', async () => {
    const fetchMock = vi.fn(async () => json(200, { text: '#0 user: hi', images: [{ mimeType: 'image/png', data: 'AAA=' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await callTool('zoom', { id: 0, n: 1 });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(/\/api\/endless\/zoom\?id=0&n=1$/);
    expect(r.content).toEqual([{ type: 'text', text: '#0 user: hi' }, { type: 'image', data: 'AAA=', mimeType: 'image/png' }]);
    expect(r.isError).toBeUndefined();
  });

  it('reports a daemon error as an MCP error, never a crash', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { error: 'n must be a power of 2 and id a multiple of n' })));
    const r = await callTool('zoom', { id: 0, n: 3 });
    expect(r.isError).toBe(true);
    expect((r.content[0] as any).text).toMatch(/power of 2/);
  });

  it('read_thread joins the assistant output and lists the tools', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { items: [
      { kind: 'assistant', text: 'one' }, { kind: 'tool', toolName: 'Bash' }, { kind: 'assistant', text: 'two' },
    ] })));
    const r = await callTool('read_thread', { id: 't1' });
    expect(JSON.parse((r.content[0] as any).text)).toMatchObject({ id: 't1', output: 'one\n\ntwo', tools: ['Bash'] });
  });
  const calls = (m: ReturnType<typeof vi.fn>) =>
    m.mock.calls.map((c) => [String(c[0]).replace(/^http:\/\/localhost:\d+/, ''), (c[1] as RequestInit | undefined)?.method ?? 'GET']);
  /** A fetch that answers by URL: the first key that the URL ends with (or, for /conversation, includes). */
  const routes = (table: Record<string, Response>) => vi.fn(async (url: any) => {
    const u = String(url).replace(/^http:\/\/localhost:\d+/, '').split('?')[0];
    const hit = Object.keys(table).find((k) => u.endsWith(k));
    if (!hit) throw new Error(`unrouted ${u}`);
    return table[hit].clone();
  });
  const bodyOf = (m: ReturnType<typeof vi.fn>, k: number) => JSON.parse(String((m.mock.calls[k][1] as RequestInit).body));

  it('spawn_agent resolves the project, creates a Chat thread there with the Control Plane defaults, arms its report, then sends the task', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { id: 's1', name: 'salsify', folder: '/w/salsify' }))
      .mockResolvedValueOnce(json(200, { harness: 'claude-code', available: true }))
      .mockResolvedValueOnce(json(201, { id: 't9', label: 'Fix login' }))
      .mockResolvedValueOnce(json(200, { armed: true }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await callTool('spawn_agent', { project: 'salsify', agentType: 'implementer', name: 'Fix login', task: 'Fix the login bug in /w/salsify/src/login.ts' });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse((r.content[0] as any).text)).toEqual({ agentId: 't9', label: 'Fix login', project: 'salsify', projectId: 's1', folder: '/w/salsify' });
    expect(calls(fetchMock)).toEqual([
      ['/api/endless/project?ref=salsify', 'GET'],
      ['/api/sessions/s1/overseer/worker-defaults?agentType=implementer', 'GET'],
      ['/api/sessions/s1/terminals', 'POST'],
      ['/api/endless/arm', 'POST'],
      ['/api/terminals/t9/message', 'POST'],
    ]);
    expect(bodyOf(fetchMock, 2).config).toEqual({ transport: 'structured', agentType: 'implementer', role: 'agent', spawnDepth: 1, origin: 'endless' });
    expect(bodyOf(fetchMock, 3)).toEqual({ terminalId: 't9' });
    expect(bodyOf(fetchMock, 4)).toEqual({ text: 'Fix the login bug in /w/salsify/src/login.ts', source: 'coordinator' });
  });

  it("spawn_agent with an unknown project creates nothing and returns the daemon's error", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(400, { error: 'unknown project "salsfy". Known projects: salsify' }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await callTool('spawn_agent', { project: 'salsfy', agentType: 'researcher', task: 'look' });
    expect(r.isError).toBe(true);
    expect((r.content[0] as any).text).toBe('Error: unknown project "salsfy". Known projects: salsify');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('spawn_agent refuses a bad agentType or an empty task before any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await callTool('spawn_agent', { project: 'salsify', agentType: 'wizard', task: 'x' })).isError).toBe(true);
    expect((await callTool('spawn_agent', { project: 'salsify', agentType: 'researcher' })).isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('message_thread arms the report, looks for a pending question, then sends a normal turn; an unknown thread sends nothing', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { armed: true }))
      .mockResolvedValueOnce(json(200, null))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await callTool('message_thread', { id: 't9', text: 'Also fix the logout.' });
    expect(JSON.parse((r.content[0] as any).text)).toEqual({ ok: true, id: 't9', path: 'turn' });
    expect(calls(fetchMock)).toEqual([['/api/endless/arm', 'POST'], ['/api/terminals/t9/permission', 'GET'], ['/api/terminals/t9/message', 'POST']]);

    const bad = vi.fn().mockResolvedValueOnce(json(400, { error: 'unknown thread: nope' }));
    vi.stubGlobal('fetch', bad);
    const r2 = await callTool('message_thread', { id: 'nope', text: 'hi' });
    expect((r2.content[0] as any).text).toBe('Error: unknown thread: nope');
    expect(bad).toHaveBeenCalledTimes(1);
  });

  describe('message_thread on a thread parked on an AskUserQuestion card', () => {
    const PENDING = {
      requestId: 'req-7', toolName: 'AskUserQuestion', input: {},
      questions: [{ header: 'Store', question: 'Which store goes first?', options: [{ label: 'Outlet' }, { label: 'Main' }] }],
    };

    it('answers the card with the text (deny + reply + requestId) and sends no turn', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(json(200, { armed: true }))
        .mockResolvedValueOnce(json(200, PENDING))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      vi.stubGlobal('fetch', fetchMock);
      const r = await callTool('message_thread', { id: 't9', text: 'Outlet first.' });
      expect(r.isError).toBeUndefined();
      expect(calls(fetchMock)).toEqual([['/api/endless/arm', 'POST'], ['/api/terminals/t9/permission', 'GET'], ['/api/terminals/t9/permission', 'POST']]);
      expect(bodyOf(fetchMock, 2)).toEqual({ decision: 'deny', reply: 'Outlet first.', requestId: 'req-7' });
      const out = JSON.parse((r.content[0] as any).text);
      expect(out).toMatchObject({ ok: true, id: 't9', path: 'question-answer' });
      expect(out.note).toMatch(/answered the question card/i);
    });

    it('falls back to a normal turn when the harness cannot take a reply (409), and says so', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(json(200, { armed: true }))
        .mockResolvedValueOnce(json(200, PENDING))
        .mockResolvedValueOnce(json(409, { error: 'this harness cannot take a reply to a question' }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      vi.stubGlobal('fetch', fetchMock);
      const r = await callTool('message_thread', { id: 't9', text: 'Outlet first.' });
      expect(r.isError).toBeUndefined();
      expect(calls(fetchMock).map((c) => c[0])).toEqual(['/api/endless/arm', '/api/terminals/t9/permission', '/api/terminals/t9/permission', '/api/terminals/t9/message']);
      const out = JSON.parse((r.content[0] as any).text);
      expect(out).toMatchObject({ ok: true, id: 't9', path: 'turn' });
      expect(out.note).toMatch(/cannot take a reply/i);
    });

    it('falls back to a normal turn when the question is gone (404)', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(json(200, { armed: true }))
        .mockResolvedValueOnce(json(200, PENDING))
        .mockResolvedValueOnce(json(404, { error: 'no pending question with that requestId' }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      vi.stubGlobal('fetch', fetchMock);
      const r = await callTool('message_thread', { id: 't9', text: 'Outlet first.' });
      expect(JSON.parse((r.content[0] as any).text)).toMatchObject({ ok: true, path: 'turn' });
      expect(calls(fetchMock)[3]).toEqual(['/api/terminals/t9/message', 'POST']);
    });

    it('a held tool call (no questions) is not a question: the text goes as a normal turn', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(json(200, { armed: true }))
        .mockResolvedValueOnce(json(200, { requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      vi.stubGlobal('fetch', fetchMock);
      const r = await callTool('message_thread', { id: 't9', text: 'go on' });
      expect(JSON.parse((r.content[0] as any).text)).toMatchObject({ path: 'turn' });
      expect(calls(fetchMock).map((c) => c[0])).toEqual(['/api/endless/arm', '/api/terminals/t9/permission', '/api/terminals/t9/message']);
    });

    it('a failed look at the card (an older daemon refuses it) still sends a normal turn', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(json(200, { armed: true }))
        .mockResolvedValueOnce(json(403, { error: 'owner_only' }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      vi.stubGlobal('fetch', fetchMock);
      const r = await callTool('message_thread', { id: 't9', text: 'go on' });
      expect(JSON.parse((r.content[0] as any).text)).toMatchObject({ ok: true, path: 'turn' });
    });

    it('any other failure of the answer disarms and returns the error', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(json(200, { armed: true }))
        .mockResolvedValueOnce(json(200, PENDING))
        .mockResolvedValueOnce(json(500, { error: 'boom' }))
        .mockResolvedValueOnce(json(200, { disarmed: true }));
      vi.stubGlobal('fetch', fetchMock);
      const r = await callTool('message_thread', { id: 't9', text: 'x' });
      expect(r.isError).toBe(true);
      expect((r.content[0] as any).text).toBe('Error: boom');
      expect(calls(fetchMock).map((c) => c[0])).toEqual(['/api/endless/arm', '/api/terminals/t9/permission', '/api/terminals/t9/permission', '/api/endless/disarm']);
    });
  });

  it('read_agent returns the status, output and tools', async () => {
    vi.stubGlobal('fetch', routes({
      '/conversation': json(200, { items: [{ kind: 'assistant', text: 'done' }] }),
      '/permission': json(200, null),
      '/api/terminals/t9': json(200, { status: 'waiting', config: { origin: 'endless' } }),
    }));
    const r = await callTool('read_agent', { agentId: 't9' });
    expect(JSON.parse((r.content[0] as any).text)).toEqual({ agentId: 't9', status: 'waiting', output: 'done', tools: [] });
  });

  describe('a thread parked on an AskUserQuestion card', () => {
    const PENDING = {
      requestId: 'req-7', toolName: 'AskUserQuestion', input: {},
      questions: [{ header: 'Store', question: 'Which store goes first?', options: [{ label: 'Outlet', description: 'x' }, 'Main'] }],
    };
    const world = () => routes({
      '/conversation': json(200, { items: [{ kind: 'assistant', text: 'stale text' }, { kind: 'tool', toolName: 'AskUserQuestion' }] }),
      '/permission': json(200, PENDING),
      '/api/terminals/t9': json(200, { status: 'working', config: { origin: 'endless' } }),
    });

    it('read_agent says needs_input, and shows the question, its options and the requestId', async () => {
      vi.stubGlobal('fetch', world());
      const out = JSON.parse(((await callTool('read_agent', { agentId: 't9' })).content[0] as any).text);
      expect(out.status).toBe('needs_input');
      expect(out.pendingQuestion).toEqual({ requestId: 'req-7', questions: [{ header: 'Store', question: 'Which store goes first?', options: ['Outlet', 'Main'] }] });
      expect(out.note).toMatch(/waiting on a question/i);
      expect(out.note).toMatch(/message_thread/);
      expect(out.output).toBe('stale text');
    });

    it('read_thread says the same', async () => {
      vi.stubGlobal('fetch', world());
      const out = JSON.parse(((await callTool('read_thread', { id: 't9' })).content[0] as any).text);
      expect(out.status).toBe('needs_input');
      expect(out.pendingQuestion.questions[0].question).toBe('Which store goes first?');
      expect(out.note).toMatch(/waiting on a question/i);
    });

    it('a thread that Chat did not start: no look at its card (the key may not), status as the daemon says', async () => {
      const f = routes({
        '/conversation': json(200, { items: [] }),
        '/permission': json(403, { error: 'out_of_scope' }),
        '/api/terminals/t9': json(200, { status: 'working', config: { origin: 'user' } }),
      });
      vi.stubGlobal('fetch', f);
      for (const [tool, arg] of [['read_agent', { agentId: 't9' }], ['read_thread', { id: 't9' }]] as const) {
        const out = JSON.parse(((await callTool(tool, arg)).content[0] as any).text);
        expect(out.status).toBe('working');
        expect(out.pendingQuestion).toBeUndefined();
      }
      expect(calls(f).map((c) => c[0]).filter((u) => u.endsWith('/permission'))).toEqual([]);
    });

    it('a held tool call is not a question: the status stays as the daemon says', async () => {
      vi.stubGlobal('fetch', routes({
        '/conversation': json(200, { items: [] }),
        '/permission': json(200, { requestId: 'r1', toolName: 'Bash', input: {} }),
        '/api/terminals/t9': json(200, { status: 'working', config: { origin: 'endless' } }),
      }));
      const out = JSON.parse(((await callTool('read_agent', { agentId: 't9' })).content[0] as any).text);
      expect(out.status).toBe('working');
      expect(out.pendingQuestion).toBeUndefined();
    });
  });

  it('the ledger tools post the project and the arguments to the Chat ledger route', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { id: 'N1', line: 'N1 · Rotate the staging key' }))
      .mockResolvedValueOnce(json(200, { text: 'Open: N1', openIds: ['N1'], rules: ['N4 · Never deploy on Fridays'] }));
    vi.stubGlobal('fetch', fetchMock);
    const add = await callTool('ledger_add', { project: 'salsify', kind: 'do', text: 'Rotate the key.', title: 'Rotate the staging key' });
    expect(JSON.parse((add.content[0] as any).text)).toEqual({ id: 'N1', line: 'N1 · Rotate the staging key' });
    expect(calls(fetchMock)[0]).toEqual(['/api/endless/ledger/add', 'POST']);
    expect(bodyOf(fetchMock, 0)).toEqual({ project: 'salsify', kind: 'do', text: 'Rotate the key.', title: 'Rotate the staging key' });
    const list = await callTool('ledger_list', { project: 'salsify' });
    expect((list.content[0] as any).text).toBe('Open: N1\n\nProject rules:\n- N4 · Never deploy on Fridays');
  });

  it('message_thread on a thread that Chat did not start returns the error and sends nothing', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(400, { error: 'not a Chat thread: t2' }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await callTool('message_thread', { id: 't2', text: 'hi' });
    expect(r.isError).toBe(true);
    expect((r.content[0] as any).text).toBe('Error: not a Chat thread: t2');
    expect(calls(fetchMock)).toEqual([['/api/endless/arm', 'POST']]);
  });

  it('spawn_agent sends no task when the arm fails, and returns the error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { id: 's1', name: 'salsify', folder: '/w/salsify' }))
      .mockResolvedValueOnce(json(200, { harness: 'claude-code', available: true }))
      .mockResolvedValueOnce(json(201, { id: 't9', label: 'Fix login' }))
      .mockResolvedValueOnce(json(400, { error: 'not a Chat thread: t9' }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await callTool('spawn_agent', { project: 'salsify', agentType: 'implementer', task: 'x' });
    expect(r.isError).toBe(true);
    expect((r.content[0] as any).text).toBe('Error: not a Chat thread: t9');
    expect(calls(fetchMock).map((c) => c[0])).not.toContain('/api/terminals/t9/message');
  });

  it('message_thread: a failed send disarms, then returns the send error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { armed: true }))
      .mockResolvedValueOnce(json(200, null))
      .mockResolvedValueOnce(json(500, { error: 'boom' }))
      .mockResolvedValueOnce(json(200, { disarmed: true }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await callTool('message_thread', { id: 't9', text: 'hi' });
    expect(r.isError).toBe(true);
    expect((r.content[0] as any).text).toMatch(/\/api\/terminals\/t9\/message -> 500/);
    expect(calls(fetchMock)).toEqual([['/api/endless/arm', 'POST'], ['/api/terminals/t9/permission', 'GET'], ['/api/terminals/t9/message', 'POST'], ['/api/endless/disarm', 'POST']]);
    expect(bodyOf(fetchMock, 3)).toEqual({ terminalId: 't9' });
  });

  it('spawn_agent: a failed send disarms, then deletes the thread, and returns the send error even if both fail', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { id: 's1', name: 'salsify', folder: '/w/salsify' }))
      .mockResolvedValueOnce(json(200, { harness: 'claude-code', available: true }))
      .mockResolvedValueOnce(json(201, { id: 't9' }))
      .mockResolvedValueOnce(json(200, { armed: true }))
      .mockResolvedValueOnce(json(500, { error: 'boom' }))
      .mockResolvedValueOnce(json(500, { error: 'disarm failed' }))
      .mockResolvedValueOnce(json(500, { error: 'delete failed' }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await callTool('spawn_agent', { project: 'salsify', agentType: 'implementer', task: 'x' });
    expect(r.isError).toBe(true);
    expect((r.content[0] as any).text).toMatch(/message -> 500/);
    expect(calls(fetchMock).slice(3)).toEqual([
      ['/api/endless/arm', 'POST'], ['/api/terminals/t9/message', 'POST'], ['/api/endless/disarm', 'POST'], ['/api/terminals/t9', 'DELETE'],
    ]);
  });

  it('spawn_agent: a failed arm deletes the thread and does not disarm', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { id: 's1', name: 'salsify', folder: '/w/salsify' }))
      .mockResolvedValueOnce(json(200, { harness: 'claude-code', available: true }))
      .mockResolvedValueOnce(json(201, { id: 't9' }))
      .mockResolvedValueOnce(json(400, { error: 'not a Chat thread: t9' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await callTool('spawn_agent', { project: 'salsify', agentType: 'implementer', task: 'x' });
    expect((r.content[0] as any).text).toBe('Error: not a Chat thread: t9');
    expect(calls(fetchMock).slice(3)).toEqual([['/api/endless/arm', 'POST'], ['/api/terminals/t9', 'DELETE']]);
  });

  it('ledger_add does not offer the source kind "user"; the Control Plane schema keeps it', () => {
    const add = TOOLS.find((t) => t.name === 'ledger_add') as any;
    const kinds: string[] = add.inputSchema.properties.source.properties.kind.enum;
    expect(kinds).toEqual(['plan', 'doc', 'agent', 'thread', 'pr', 'issue', 'overseer']);
    expect(JSON.stringify(add.inputSchema.properties.source)).not.toMatch(/user:/);
    expect((CARD_FIELDS_SCHEMA.source.properties.kind.enum as readonly string[])).toContain('user');
    expect(TOOLS.map((t) => t.name)).not.toContain('watch_thread');
  });
  describe('the Chat key', () => {
    const KEY = `dck_${'C'.repeat(43)}`;
    const saved = { api: process.env.DISPATCH_API, auth: process.env.DISPATCH_AUTH };
    afterEach(() => {
      if (saved.api === undefined) delete process.env.DISPATCH_API; else process.env.DISPATCH_API = saved.api;
      if (saved.auth === undefined) delete process.env.DISPATCH_AUTH; else process.env.DISPATCH_AUTH = saved.auth;
    });
    const hdr = (m: ReturnType<typeof vi.fn>, k: number) => ((m.mock.calls[k][1] as RequestInit | undefined)?.headers ?? {}) as Record<string, string>;

    it('every route sends Authorization: Bearer KEY to the daemon URL', async () => {
      process.env.DISPATCH_API = 'http://localhost:9977';
      process.env.DISPATCH_AUTH = KEY;
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(json(200, { id: 's1', name: 'salsify', folder: '/w/salsify' }))
        .mockResolvedValueOnce(json(200, { harness: 'claude-code', available: true }))
        .mockResolvedValueOnce(json(201, { id: 't9', label: 'Fix login' }))
        .mockResolvedValueOnce(json(200, { armed: true }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      vi.stubGlobal('fetch', fetchMock);
      await callTool('spawn_agent', { project: 'salsify', agentType: 'implementer', task: 'x' });
      expect(fetchMock).toHaveBeenCalledTimes(5);
      for (let k = 0; k < 5; k++) expect(hdr(fetchMock, k).Authorization).toBe(`Bearer ${KEY}`);
      const z = vi.fn(async () => json(200, { text: 't', images: [] }));
      vi.stubGlobal('fetch', z);
      await callTool('zoom', { id: 0, n: 1 });
      expect(hdr(z, 0).Authorization).toBe(`Bearer ${KEY}`);
      const l = vi.fn(async () => json(200, { text: 'x', rules: [] }));
      vi.stubGlobal('fetch', l);
      await callTool('ledger_list', { project: 'p' });
      expect(hdr(l, 0).Authorization).toBe(`Bearer ${KEY}`);
    });

    it('sends nothing without DISPATCH_API, and nothing without a key', async () => {
      process.env.DISPATCH_AUTH = KEY;
      delete process.env.DISPATCH_API;
      const a = vi.fn(async () => json(200, { text: 't', images: [] }));
      vi.stubGlobal('fetch', a);
      await callTool('zoom', { id: 0, n: 1 });
      expect(hdr(a, 0).Authorization).toBeUndefined();
      process.env.DISPATCH_API = 'http://localhost:9977';
      delete process.env.DISPATCH_AUTH;
      const b = vi.fn(async () => json(200, { text: 't', images: [] }));
      vi.stubGlobal('fetch', b);
      await callTool('zoom', { id: 0, n: 1 });
      expect(hdr(b, 0).Authorization).toBeUndefined();
    });

    it('shows a key refusal with the fixed texts', async () => {
      process.env.DISPATCH_API = 'http://localhost:9977';
      process.env.DISPATCH_AUTH = KEY;
      vi.stubGlobal('fetch', vi.fn(async () => json(403, { error: 'owner_only', message: 'raw' })));
      const r = await callTool('zoom', { id: 0, n: 1 });
      expect((r.content[0] as any).text).toBe('Error: only the owner can do this. Ask the owner to do it in the browser.');
    });
  });
});
