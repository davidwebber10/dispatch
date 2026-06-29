import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleRequest, callTool, TOOLS } from '../../src/overseer/agency-mcp.js';

describe('agency-mcp', () => {
  const origFetch = global.fetch;
  const origApi = process.env.DISPATCH_API;
  const origSession = process.env.DISPATCH_SESSION;

  beforeEach(() => {
    process.env.DISPATCH_API = 'http://localhost:9999';
    process.env.DISPATCH_SESSION = 'sess-1';
  });
  afterEach(() => {
    global.fetch = origFetch;
    if (origApi === undefined) delete process.env.DISPATCH_API; else process.env.DISPATCH_API = origApi;
    if (origSession === undefined) delete process.env.DISPATCH_SESSION; else process.env.DISPATCH_SESSION = origSession;
    vi.restoreAllMocks();
  });

  it('tools/list returns the four agency tools', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res).not.toBeNull();
    const names = (res!.result as any).tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['complete_agent', 'list_agents', 'message_agent', 'spawn_agent']);
    expect(TOOLS).toHaveLength(4);
  });

  it('initialize returns protocolVersion + tools capability', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', id: 0, method: 'initialize' });
    const r = res!.result as any;
    expect(typeof r.protocolVersion).toBe('string');
    expect(r.capabilities).toHaveProperty('tools');
  });

  it('notifications (no id) get no response', async () => {
    expect(await handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('spawn_agent issues create + seed-message fetches and returns the agentId', async () => {
    const fetchMock = vi.fn()
      // 1) create terminal -> returns the new terminal JSON
      .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'agent-1', label: 'researcher agent' }) })
      // 2) seed message -> 204 no body
      .mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
    global.fetch = fetchMock as any;

    const out = await callTool('spawn_agent', { agentType: 'researcher', task: 'investigate X' });
    expect(out.isError).toBeUndefined();
    expect(JSON.parse(out.content[0].text)).toEqual({ agentId: 'agent-1', label: 'researcher agent' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // create
    const [createUrl, createInit] = fetchMock.mock.calls[0];
    expect(createUrl).toBe('http://localhost:9999/api/sessions/sess-1/terminals');
    expect(createInit.method).toBe('POST');
    expect(JSON.parse(createInit.body)).toEqual({
      type: 'claude-code',
      label: 'researcher agent',
      config: { transport: 'structured', agentType: 'researcher', role: 'agent' },
    });
    // seed message
    const [msgUrl, msgInit] = fetchMock.mock.calls[1];
    expect(msgUrl).toBe('http://localhost:9999/api/terminals/agent-1/message');
    expect(msgInit.method).toBe('POST');
    expect(JSON.parse(msgInit.body)).toEqual({ text: 'investigate X' });
  });

  it('spawn_agent honors a custom name as the label', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'a2', label: 'Recon' }) })
      .mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
    global.fetch = fetchMock as any;
    await callTool('spawn_agent', { agentType: 'planner', name: 'Recon', task: 'plan it' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).label).toBe('Recon');
  });

  it('list_agents filters to agent-role / typed threads', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify([
        { id: 'c1', label: 'Overseer', status: 'idle', config: { role: 'coordinator' } },
        { id: 'a1', label: 'researcher agent', status: 'working', config: { role: 'agent', agentType: 'researcher' } },
        { id: 'a2', label: 'planner agent', status: 'idle', config: { agentType: 'planner' } },
        { id: 's1', label: 'Terminal', status: 'idle', config: {} },
      ]),
    });
    global.fetch = fetchMock as any;
    const out = await callTool('list_agents', {});
    expect(out.isError).toBeUndefined();
    expect(JSON.parse(out.content[0].text)).toEqual([
      { id: 'a1', label: 'researcher agent', agentType: 'researcher', status: 'working' },
      { id: 'a2', label: 'planner agent', agentType: 'planner', status: 'idle' },
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/api/sessions/sess-1/terminals');
  });

  it('message_agent POSTs the text to the agent thread', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
    global.fetch = fetchMock as any;
    const out = await callTool('message_agent', { agentId: 'a1', text: 'focus on auth' });
    expect(out.isError).toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/api/terminals/a1/message');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: 'focus on auth' });
  });

  it('complete_agent archives the thread (DELETE)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
    global.fetch = fetchMock as any;
    const out = await callTool('complete_agent', { agentId: 'a1' });
    expect(out.isError).toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/api/terminals/a1');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  it('returns MCP isError content (never throws) on HTTP failure', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error', text: async () => 'boom' });
    global.fetch = fetchMock as any;
    const out = await callTool('spawn_agent', { agentType: 'researcher', task: 'x' });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('Error:');
  });

  it('tools/call routes through handleRequest and reports unknown tools as isError', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope', arguments: {} } });
    const r = res!.result as any;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Unknown tool');
  });
});
