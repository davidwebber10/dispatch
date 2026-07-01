import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

  it('tools/list returns the agency tools', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res).not.toBeNull();
    const names = (res!.result as any).tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['answer_agent', 'complete_agent', 'list_agents', 'list_missions', 'message_agent', 'post_image', 'queue_agent', 'read_agent', 'spawn_agent', 'start_agent']);
    expect(TOOLS).toHaveLength(10);
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
    expect(JSON.parse(msgInit.body)).toEqual({ text: 'investigate X', source: 'coordinator' });
  });

  it('read_agent returns the agent assistant output + tools + status (the read channel)', async () => {
    const fetchMock = vi.fn()
      // 1) GET /conversation -> items
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ items: [
        { kind: 'user', text: 'investigate the repo' },
        { kind: 'assistant', text: 'Found A' },
        { kind: 'tool', toolName: 'Grep' },
        { kind: 'assistant', text: 'Recommend B' },
      ] }) })
      // 2) GET /terminals/:id -> status
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ id: 'agent-1', status: 'waiting' }) });
    global.fetch = fetchMock as any;

    const out = await callTool('read_agent', { agentId: 'agent-1' });
    expect(out.isError).toBeUndefined();
    expect(JSON.parse(out.content[0].text)).toEqual({
      agentId: 'agent-1',
      status: 'waiting',
      output: 'Found A\n\nRecommend B',
      tools: ['Grep'],
    });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/api/terminals/agent-1/conversation?limit=500');
  });

  it('spawn_agent forwards a mission into the create body config', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'a3', label: 'implementer agent' }) })
      .mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
    global.fetch = fetchMock as any;
    const out = await callTool('spawn_agent', { agentType: 'implementer', task: 'do it', mission: 'Auth refactor' });
    expect(out.isError).toBeUndefined();
    expect(JSON.parse(out.content[0].text)).toEqual({ agentId: 'a3', label: 'implementer agent', mission: 'Auth refactor' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      type: 'claude-code',
      label: 'implementer agent',
      config: { transport: 'structured', agentType: 'implementer', role: 'agent', mission: 'Auth refactor' },
    });
  });

  it('spawn_agent omits mission from config when not provided', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'a4', label: 'researcher agent' }) })
      .mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
    global.fetch = fetchMock as any;
    await callTool('spawn_agent', { agentType: 'researcher', task: 'look' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).config).toEqual({
      transport: 'structured', agentType: 'researcher', role: 'agent',
    });
  });

  it('list_missions aggregates distinct missions with live/total counts', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify([
        { id: 'c1', label: 'Overseer', status: 'working', config: { role: 'coordinator' } },
        { id: 'a1', label: 'researcher', status: 'working', config: { role: 'agent', agentType: 'researcher', mission: 'Auth refactor' } },
        { id: 'a2', label: 'implementer', status: 'done', config: { role: 'agent', agentType: 'implementer', mission: 'Auth refactor' } },
        { id: 'a3', label: 'planner', status: 'needs_input', config: { agentType: 'planner', mission: 'Checkout bug' } },
        { id: 'a4', label: 'reviewer', status: 'waiting', config: { agentType: 'reviewer' } },
        { id: 's1', label: 'Terminal', status: 'waiting', config: {} },
      ]),
    });
    global.fetch = fetchMock as any;
    const out = await callTool('list_missions', {});
    expect(out.isError).toBeUndefined();
    expect(JSON.parse(out.content[0].text)).toEqual([
      { mission: 'Auth refactor', live: 1, total: 2 },
      { mission: 'Checkout bug', live: 1, total: 1 },
      { mission: 'General', live: 1, total: 1 },
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/api/sessions/sess-1/terminals');
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
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: 'focus on auth', source: 'coordinator' });
  });

  it('complete_agent archives the thread (DELETE)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
    global.fetch = fetchMock as any;
    const out = await callTool('complete_agent', { agentId: 'a1' });
    expect(out.isError).toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/api/terminals/a1');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  it('queue_agent parks the task in a single queued create (no seed message) and returns queued:true', async () => {
    const fetchMock = vi.fn()
      // create terminal (queued) -> returns the new terminal JSON. No second (message) fetch.
      .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'q1', label: 'researcher agent' }) });
    global.fetch = fetchMock as any;

    const out = await callTool('queue_agent', { agentType: 'researcher', task: 'investigate X' });
    expect(out.isError).toBeUndefined();
    expect(JSON.parse(out.content[0].text)).toEqual({ agentId: 'q1', label: 'researcher agent', queued: true });

    // Unlike spawn_agent, queueing does NOT seed a message — the task is parked in the create body.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [createUrl, createInit] = fetchMock.mock.calls[0];
    expect(createUrl).toBe('http://localhost:9999/api/sessions/sess-1/terminals');
    expect(createInit.method).toBe('POST');
    expect(JSON.parse(createInit.body)).toEqual({
      type: 'claude-code',
      label: 'researcher agent',
      queued: true,
      task: 'investigate X',
      config: { transport: 'structured', agentType: 'researcher', role: 'agent' },
    });
  });

  it('queue_agent forwards a mission into the create body config', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'q2', label: 'implementer agent' }) });
    global.fetch = fetchMock as any;
    const out = await callTool('queue_agent', { agentType: 'implementer', task: 'do it', mission: 'Auth refactor' });
    expect(out.isError).toBeUndefined();
    expect(JSON.parse(out.content[0].text)).toEqual({ agentId: 'q2', label: 'implementer agent', mission: 'Auth refactor', queued: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).config).toEqual({
      transport: 'structured', agentType: 'implementer', role: 'agent', mission: 'Auth refactor',
    });
  });

  it('queue_agent forwards dependsOn into the create body config', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'q3', label: 'implementer agent' }) });
    global.fetch = fetchMock as any;
    const out = await callTool('queue_agent', { agentType: 'implementer', task: 'do it', dependsOn: 'agent-1' });
    expect(out.isError).toBeUndefined();
    expect(JSON.parse(out.content[0].text)).toEqual({ agentId: 'q3', label: 'implementer agent', queued: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).config).toEqual({
      transport: 'structured', agentType: 'implementer', role: 'agent', dependsOn: 'agent-1',
    });
  });

  it('queue_agent omits dependsOn from config when not provided', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'q4', label: 'researcher agent' }) });
    global.fetch = fetchMock as any;
    await callTool('queue_agent', { agentType: 'researcher', task: 'look' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).config).toEqual({
      transport: 'structured', agentType: 'researcher', role: 'agent',
    });
  });

  it('start_agent promotes a queued agent via POST /start (no body) and returns ok', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
    global.fetch = fetchMock as any;
    const out = await callTool('start_agent', { agentId: 'q1' });
    expect(out.isError).toBeUndefined();
    expect(JSON.parse(out.content[0].text)).toEqual({ ok: true, agentId: 'q1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [startUrl, startInit] = fetchMock.mock.calls[0];
    expect(startUrl).toBe('http://localhost:9999/api/terminals/q1/start');
    expect(startInit.method).toBe('POST');
    // Promotion carries no payload — httpJson omits both body and content-type.
    expect(startInit.body).toBeUndefined();
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

describe('agency-mcp post_image', () => {
  // post_image sandboxes to process.cwd() (the coordinator's project root). Run each case
  // inside a throwaway dir we chdir into, so a relative path resolves there and "outside the
  // working dir" is meaningful — restored + cleaned up after each test.
  let tmpDir: string;
  let prevCwd: string;
  // A 1×1 transparent PNG. The exact bytes are irrelevant — we only assert the base64 round-trips.
  const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pV4AAAAAElFTkSuQmCC';

  beforeEach(() => {
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agency-postimg-'));
    process.chdir(tmpDir);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('reads an image file and returns an MCP image content block (base64 + mime + alt)', async () => {
    fs.writeFileSync(path.join(process.cwd(), 'shot.png'), Buffer.from(PNG_BASE64, 'base64'));
    const out = await callTool('post_image', { path: 'shot.png', alt: 'a screenshot' });
    expect(out.isError).toBeUndefined();
    expect(out.content).toHaveLength(1);
    const block = out.content[0] as any;
    expect(block.type).toBe('image');
    expect(block.mimeType).toBe('image/png');
    expect(block.data).toBe(PNG_BASE64);
    expect(block.alt).toBe('a screenshot');
  });

  it('resolves an in-tree subdir path (e.g. .dispatch/inbox) and infers mime from extension', async () => {
    const dir = path.join(process.cwd(), '.dispatch', 'inbox');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'chart.webp'), Buffer.from(PNG_BASE64, 'base64'));
    const out = await callTool('post_image', { path: '.dispatch/inbox/chart.webp' });
    expect(out.isError).toBeUndefined();
    const block = out.content[0] as any;
    expect(block.type).toBe('image');
    expect(block.mimeType).toBe('image/webp');
    expect(block.alt).toBeUndefined();
  });

  it('rejects a path that escapes the working dir (sandbox)', async () => {
    const out = await callTool('post_image', { path: '../escape.png' });
    expect(out.isError).toBe(true);
    expect((out.content[0] as any).text).toContain('outside the working directory');
  });

  it('rejects an unsupported (non-image) extension before reading it', async () => {
    fs.writeFileSync(path.join(process.cwd(), 'notes.txt'), 'hello');
    const out = await callTool('post_image', { path: 'notes.txt' });
    expect(out.isError).toBe(true);
    expect((out.content[0] as any).text).toContain('unsupported image type');
  });

  it('reports a missing path as isError (never throws)', async () => {
    const out = await callTool('post_image', {});
    expect(out.isError).toBe(true);
    expect((out.content[0] as any).text).toContain('path is required');
  });

  it('reports a non-existent in-tree file as isError', async () => {
    const out = await callTool('post_image', { path: 'gone.png' });
    expect(out.isError).toBe(true);
  });
});
