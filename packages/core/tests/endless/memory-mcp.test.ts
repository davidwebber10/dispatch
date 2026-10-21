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
    expect(JSON.parse((r.content[0] as any).text)).toEqual({ id: 't1', output: 'one\n\ntwo', tools: ['Bash'] });
  });
  const calls = (m: ReturnType<typeof vi.fn>) =>
    m.mock.calls.map((c) => [String(c[0]).replace(/^http:\/\/localhost:\d+/, ''), (c[1] as RequestInit | undefined)?.method ?? 'GET']);
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

  it('message_thread arms the report, then sends; an unknown thread sends nothing', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { armed: true }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await callTool('message_thread', { id: 't9', text: 'Also fix the logout.' });
    expect(JSON.parse((r.content[0] as any).text)).toEqual({ ok: true, id: 't9' });
    expect(calls(fetchMock)).toEqual([['/api/endless/arm', 'POST'], ['/api/terminals/t9/message', 'POST']]);

    const bad = vi.fn().mockResolvedValueOnce(json(400, { error: 'unknown thread: nope' }));
    vi.stubGlobal('fetch', bad);
    const r2 = await callTool('message_thread', { id: 'nope', text: 'hi' });
    expect((r2.content[0] as any).text).toBe('Error: unknown thread: nope');
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it('read_agent returns the status, output and tools', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json(200, { items: [{ kind: 'assistant', text: 'done' }] }))
      .mockResolvedValueOnce(json(200, { status: 'waiting' })));
    const r = await callTool('read_agent', { agentId: 't9' });
    expect(JSON.parse((r.content[0] as any).text)).toEqual({ agentId: 't9', status: 'waiting', output: 'done', tools: [] });
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
      .mockResolvedValueOnce(json(500, { error: 'boom' }))
      .mockResolvedValueOnce(json(200, { disarmed: true }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await callTool('message_thread', { id: 't9', text: 'hi' });
    expect(r.isError).toBe(true);
    expect((r.content[0] as any).text).toMatch(/\/api\/terminals\/t9\/message -> 500/);
    expect(calls(fetchMock)).toEqual([['/api/endless/arm', 'POST'], ['/api/terminals/t9/message', 'POST'], ['/api/endless/disarm', 'POST']]);
    expect(bodyOf(fetchMock, 2)).toEqual({ terminalId: 't9' });
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
});
