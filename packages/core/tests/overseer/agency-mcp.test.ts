import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handleRequest, callTool, TOOLS } from '../../src/overseer/agency-mcp.js';
import { modelFor } from '../../src/overseer/prompts.js';

describe('agency-mcp', () => {
  const origFetch = global.fetch;
  const origApi = process.env.DISPATCH_API;
  const origSession = process.env.DISPATCH_SESSION;
  const origTerminal = process.env.DISPATCH_TERMINAL;
  const origSpawnDepth = process.env.DISPATCH_SPAWN_DEPTH;

  beforeEach(() => {
    process.env.DISPATCH_API = 'http://localhost:9999';
    process.env.DISPATCH_SESSION = 'sess-1';
    delete process.env.DISPATCH_TERMINAL;
    delete process.env.DISPATCH_SPAWN_DEPTH;
  });
  afterEach(() => {
    global.fetch = origFetch;
    if (origApi === undefined) delete process.env.DISPATCH_API; else process.env.DISPATCH_API = origApi;
    if (origSession === undefined) delete process.env.DISPATCH_SESSION; else process.env.DISPATCH_SESSION = origSession;
    if (origTerminal === undefined) delete process.env.DISPATCH_TERMINAL; else process.env.DISPATCH_TERMINAL = origTerminal;
    if (origSpawnDepth === undefined) delete process.env.DISPATCH_SPAWN_DEPTH; else process.env.DISPATCH_SPAWN_DEPTH = origSpawnDepth;
    vi.restoreAllMocks();
  });

  it('tools/list returns the agency tools', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res).not.toBeNull();
    const names = (res!.result as any).tools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      'answer_agent', 'complete_agent', 'list_agents', 'list_missions', 'list_threads', 'list_watches',
      'message_agent', 'message_thread', 'post_image', 'queue_agent', 'read_agent', 'read_thread',
      'report_status', 'spawn_agent', 'start_agent', 'unwatch_thread', 'watch_thread',
    ]);
    expect(TOOLS).toHaveLength(17);
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
      config: { transport: 'structured', agentType: 'researcher', role: 'agent', spawnDepth: 1 },
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
      config: { transport: 'structured', agentType: 'implementer', role: 'agent', mission: 'Auth refactor', spawnDepth: 1 },
    });
  });

  it('spawn_agent omits mission from config when not provided', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'a4', label: 'researcher agent' }) })
      .mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
    global.fetch = fetchMock as any;
    await callTool('spawn_agent', { agentType: 'researcher', task: 'look' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).config).toEqual({
      transport: 'structured', agentType: 'researcher', role: 'agent', spawnDepth: 1,
    });
  });

  it('spawn_agent forwards an explicit model override into the create body config', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'a5', label: 'researcher agent' }) })
      .mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
    global.fetch = fetchMock as any;
    await callTool('spawn_agent', { agentType: 'researcher', task: 'quick lookup', model: 'sonnet' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).config).toEqual({
      transport: 'structured', agentType: 'researcher', role: 'agent', model: 'sonnet', spawnDepth: 1,
    });
  });

  it('spawn_agent omits model from config when not provided (tier default applies later at spawn time)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'a6', label: 'researcher agent' }) })
      .mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
    global.fetch = fetchMock as any;
    await callTool('spawn_agent', { agentType: 'researcher', task: 'look' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).config).toEqual({
      transport: 'structured', agentType: 'researcher', role: 'agent', spawnDepth: 1,
    });
  });

  it('end-to-end: spawn_agent config resolves via modelFor to the explicit override, or the implementer tier default when omitted', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'a7', label: 'implementer agent' }) })
      .mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
    global.fetch = fetchMock as any;
    await callTool('spawn_agent', { agentType: 'implementer', task: 'hard problem', model: 'opus' });
    const overriddenConfig = JSON.parse(fetchMock.mock.calls[0][1].body).config;
    expect(modelFor(overriddenConfig)).toBe('opus'); // override wins over the implementer's sonnet default

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'a8', label: 'implementer agent' }) })
      .mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
    await callTool('spawn_agent', { agentType: 'implementer', task: 'do it' });
    const defaultConfig = JSON.parse(fetchMock.mock.calls[0][1].body).config;
    expect(modelFor(defaultConfig)).toBe('sonnet'); // falls back to the implementer tier default (no regression)
  });

  it('end-to-end: queue_agent config resolves via modelFor to the explicit override, or the researcher tier default when omitted', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'q7', label: 'researcher agent' }) });
    global.fetch = fetchMock as any;
    await callTool('queue_agent', { agentType: 'researcher', task: 'quick lookup', model: 'sonnet' });
    const overriddenConfig = JSON.parse(fetchMock.mock.calls[0][1].body).config;
    expect(modelFor(overriddenConfig)).toBe('sonnet'); // override wins over the researcher's opus default

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'q8', label: 'researcher agent' }) });
    await callTool('queue_agent', { agentType: 'researcher', task: 'investigate' });
    const defaultConfig = JSON.parse(fetchMock.mock.calls[0][1].body).config;
    expect(modelFor(defaultConfig)).toBe('opus'); // falls back to the researcher tier default (no regression)
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

  it('complete_agent archives a typed agent thread (DELETE) — role set, no force needed', async () => {
    const fetchMock = vi.fn()
      // 1) role lookup for the archive-protection guard
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ id: 'a1', config: { role: 'agent' } }) })
      // 2) DELETE archives it
      .mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
    global.fetch = fetchMock as any;
    const out = await callTool('complete_agent', { agentId: 'a1' });
    expect(out.isError).toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/api/terminals/a1');
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:9999/api/terminals/a1');
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
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
      config: { transport: 'structured', agentType: 'researcher', role: 'agent', spawnDepth: 1 },
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
      transport: 'structured', agentType: 'implementer', role: 'agent', mission: 'Auth refactor', spawnDepth: 1,
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
      transport: 'structured', agentType: 'implementer', role: 'agent', dependsOn: 'agent-1', spawnDepth: 1,
    });
  });

  it('queue_agent omits dependsOn from config when not provided', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'q4', label: 'researcher agent' }) });
    global.fetch = fetchMock as any;
    await callTool('queue_agent', { agentType: 'researcher', task: 'look' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).config).toEqual({
      transport: 'structured', agentType: 'researcher', role: 'agent', spawnDepth: 1,
    });
  });

  it('queue_agent forwards an explicit model override into the create body config', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'q5', label: 'implementer agent' }) });
    global.fetch = fetchMock as any;
    await callTool('queue_agent', { agentType: 'implementer', task: 'hard problem', model: 'opus' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).config).toEqual({
      transport: 'structured', agentType: 'implementer', role: 'agent', model: 'opus', spawnDepth: 1,
    });
  });

  it('queue_agent omits model from config when not provided (tier default applies later at spawn time)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'q6', label: 'implementer agent' }) });
    global.fetch = fetchMock as any;
    await callTool('queue_agent', { agentType: 'implementer', task: 'do it' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).config).toEqual({
      transport: 'structured', agentType: 'implementer', role: 'agent', spawnDepth: 1,
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

  describe('report_status', () => {
    it('report_status posts the declaration for the CALLING thread', async () => {
      process.env.DISPATCH_TERMINAL = 'self-1';
      const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 204, text: async () => '' });
      global.fetch = fetchMock as any;

      const out = await callTool('report_status', { state: 'needs_you', summary: 'need a decision', ask: 'Which provider?' });

      expect(out.isError).toBeFalsy();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain('/api/terminals/self-1/report-status');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ state: 'needs_you', summary: 'need a decision', ask: 'Which provider?' });
    });

    it('report_status refuses to report on another thread', async () => {
      process.env.DISPATCH_TERMINAL = 'self-1';
      const out = await callTool('report_status', { state: 'done', summary: 'x', id: 'other-thread' } as any);
      // `id` is not in the schema and must be ignored — the URL is always the caller's own.
      expect(String(out.content[0].text)).not.toContain('other-thread');
    });
  });

  // --- peer/thread tools: widen scope to every thread in the project, plus watch subs ---

  describe('list_threads', () => {
    it('includes plain (role-less) threads alongside typed agents and marks isSelf', async () => {
      process.env.DISPATCH_TERMINAL = 'self-1';
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify([
          { id: 'self-1', label: 'My Thread', type: 'claude-code', status: 'working', lastActivityAt: 't1', config: {} },
          { id: 'a1', label: 'researcher agent', type: 'claude-code', status: 'idle', lastActivityAt: 't2', config: { role: 'agent', agentType: 'researcher' } },
          { id: 'c1', label: 'Overseer', type: 'claude-code', status: 'idle', lastActivityAt: 't3', config: { role: 'coordinator' } },
        ]),
      });
      global.fetch = fetchMock as any;

      const out = await callTool('list_threads', {});
      expect(out.isError).toBeUndefined();
      expect(JSON.parse(out.content[0].text)).toEqual([
        { id: 'self-1', label: 'My Thread', type: 'claude-code', role: null, agentType: null, status: 'working', lastActivityAt: 't1', isSelf: true },
        { id: 'a1', label: 'researcher agent', type: 'claude-code', role: 'agent', agentType: 'researcher', status: 'idle', lastActivityAt: 't2', isSelf: false },
        { id: 'c1', label: 'Overseer', type: 'claude-code', role: 'coordinator', agentType: null, status: 'idle', lastActivityAt: 't3', isSelf: false },
      ]);
      expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/api/sessions/sess-1/terminals');
    });

    it('marks isSelf false for every row when DISPATCH_TERMINAL is unset (no crash)', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify([
          { id: 'p1', label: 'Plain', type: 'claude-code', status: 'idle', lastActivityAt: 't1', config: {} },
        ]),
      });
      global.fetch = fetchMock as any;
      const out = await callTool('list_threads', {});
      expect(JSON.parse(out.content[0].text)[0].isSelf).toBe(false);
    });
  });

  describe('read_thread', () => {
    it('returns the transcript tail for any thread after a project check', async () => {
      const fetchMock = vi.fn()
        // 1) assertInProject -> GET /api/terminals/:id
        .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ id: 'p1', sessionId: 'sess-1', status: 'idle' }) })
        // 2) GET conversation
        .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ items: [
          { kind: 'assistant', text: 'Did the thing' },
          { kind: 'tool', toolName: 'Edit' },
        ] }) });
      global.fetch = fetchMock as any;

      const out = await callTool('read_thread', { id: 'p1' });
      expect(out.isError).toBeUndefined();
      expect(JSON.parse(out.content[0].text)).toEqual({ id: 'p1', status: 'idle', output: 'Did the thing', tools: ['Edit'] });
      expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/api/terminals/p1');
      expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:9999/api/terminals/p1/conversation?limit=500');
    });

    it('honors an explicit tail as the conversation limit', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ id: 'p1', sessionId: 'sess-1', status: 'idle' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ items: [] }) });
      global.fetch = fetchMock as any;
      await callTool('read_thread', { id: 'p1', tail: 20 });
      expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:9999/api/terminals/p1/conversation?limit=20');
    });

    it('rejects a foreign-project id with the project error and leaks no data', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ id: 'foreign-1', sessionId: 'other-sess', status: 'idle', label: 'Secret Thread' }),
      });
      global.fetch = fetchMock as any;
      const out = await callTool('read_thread', { id: 'foreign-1' });
      expect(out.isError).toBe(true);
      expect(out.content[0].text).toBe('Error: foreign-1 is not a thread in this project');
      expect(out.content[0].text).not.toContain('Secret Thread');
      expect(out.content[0].text).not.toContain('other-sess');
      // Only the project check ran — no conversation fetch for a foreign thread.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects an unknown id (404) the same way as a foreign id', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found', text: async () => JSON.stringify({ error: 'Terminal not found' }) });
      global.fetch = fetchMock as any;
      const out = await callTool('read_thread', { id: 'nope' });
      expect(out.isError).toBe(true);
      expect(out.content[0].text).toBe('Error: nope is not a thread in this project');
    });
  });

  describe('message_thread', () => {
    it('POSTs the text to the thread after a project check', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ id: 'p1', sessionId: 'sess-1' }) })
        .mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
      global.fetch = fetchMock as any;
      const out = await callTool('message_thread', { id: 'p1', text: 'hey, status?' });
      expect(out.isError).toBeUndefined();
      expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:9999/api/terminals/p1/message');
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ text: 'hey, status?', source: 'coordinator' });
    });

    it('rejects a foreign-project id with the project error', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ id: 'foreign-1', sessionId: 'other-sess' }),
      });
      global.fetch = fetchMock as any;
      const out = await callTool('message_thread', { id: 'foreign-1', text: 'hi' });
      expect(out.isError).toBe(true);
      expect(out.content[0].text).toBe('Error: foreign-1 is not a thread in this project');
      expect(fetchMock).toHaveBeenCalledTimes(1); // no message POST for a foreign thread
    });
  });

  describe('watch_thread', () => {
    it('POSTs to /api/watches with the caller as watcherTerminalId after a project check', async () => {
      process.env.DISPATCH_TERMINAL = 'self-1';
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ id: 'p1', sessionId: 'sess-1' }) })
        .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'watch-1' }) });
      global.fetch = fetchMock as any;

      const out = await callTool('watch_thread', { id: 'p1', when: 'idle', note: 'review its diff' });
      expect(out.isError).toBeUndefined();
      expect(JSON.parse(out.content[0].text)).toEqual({ watchId: 'watch-1' });
      expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:9999/api/watches');
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
        watcherTerminalId: 'self-1', targetTerminalId: 'p1', criteria: 'idle', note: 'review its diff',
      });
    });

    it('rejects a foreign-project id with the project error before registering a watch', async () => {
      process.env.DISPATCH_TERMINAL = 'self-1';
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ id: 'foreign-1', sessionId: 'other-sess' }),
      });
      global.fetch = fetchMock as any;
      const out = await callTool('watch_thread', { id: 'foreign-1', when: 'idle' });
      expect(out.isError).toBe(true);
      expect(out.content[0].text).toBe('Error: foreign-1 is not a thread in this project');
      expect(fetchMock).toHaveBeenCalledTimes(1); // no POST /api/watches for a foreign thread
    });

    it('fails clearly when DISPATCH_TERMINAL is unset, without calling the daemon', async () => {
      // No DISPATCH_TERMINAL set (beforeEach deletes it) — an old-style injection.
      const fetchMock = vi.fn();
      global.fetch = fetchMock as any;
      const out = await callTool('watch_thread', { id: 'p1', when: 'idle' });
      expect(out.isError).toBe(true);
      expect(out.content[0].text).toContain('DISPATCH_TERMINAL');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('surfaces a 429 from the endpoint as a clear watch-limit message', async () => {
      process.env.DISPATCH_TERMINAL = 'self-1';
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ id: 'p1', sessionId: 'sess-1' }) })
        .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests', text: async () => JSON.stringify({ error: 'watcher already has 20 live watches (max) — remove one before adding another' }) });
      global.fetch = fetchMock as any;
      const out = await callTool('watch_thread', { id: 'p1', when: 'idle' });
      expect(out.isError).toBe(true);
      expect(out.content[0].text.toLowerCase()).toContain('watch limit');
    });
  });

  describe('unwatch_thread', () => {
    it('DELETEs the watch by id, scoped to the caller as watcher', async () => {
      process.env.DISPATCH_TERMINAL = 'self-1';
      const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ ok: true }) });
      global.fetch = fetchMock as any;
      const out = await callTool('unwatch_thread', { watchId: 'watch-1' });
      expect(out.isError).toBeUndefined();
      expect(JSON.parse(out.content[0].text)).toEqual({ ok: true });
      expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
      const url = new URL(fetchMock.mock.calls[0][0]);
      expect(url.origin + url.pathname).toBe('http://localhost:9999/api/watches/watch-1');
      expect(url.searchParams.get('watcher')).toBe('self-1');
    });

    it('surfaces a 404 as a clear error', async () => {
      process.env.DISPATCH_TERMINAL = 'self-1';
      const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found', text: async () => JSON.stringify({ error: 'watch not found' }) });
      global.fetch = fetchMock as any;
      const out = await callTool('unwatch_thread', { watchId: 'nope' });
      expect(out.isError).toBe(true);
      expect(out.content[0].text).toContain('watch not found');
    });

    it('fails clearly when DISPATCH_TERMINAL is unset, without calling the daemon', async () => {
      // No DISPATCH_TERMINAL set (beforeEach deletes it) — an old-style injection.
      const fetchMock = vi.fn();
      global.fetch = fetchMock as any;
      const out = await callTool('unwatch_thread', { watchId: 'watch-1' });
      expect(out.isError).toBe(true);
      expect(out.content[0].text).toContain('DISPATCH_TERMINAL');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('list_watches', () => {
    it('GETs /api/watches for the caller and returns watching + watchedBy', async () => {
      process.env.DISPATCH_TERMINAL = 'self-1';
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({
          watching: [{ id: 'w1', target_terminal_id: 'p1' }],
          watchedBy: [{ id: 'w2', watcher_terminal_id: 'p2' }],
        }),
      });
      global.fetch = fetchMock as any;
      const out = await callTool('list_watches', {});
      expect(out.isError).toBeUndefined();
      expect(JSON.parse(out.content[0].text)).toEqual({
        watching: [{ id: 'w1', target_terminal_id: 'p1' }],
        watchedBy: [{ id: 'w2', watcher_terminal_id: 'p2' }],
      });
      const url = new URL(fetchMock.mock.calls[0][0]);
      expect(url.origin + url.pathname).toBe('http://localhost:9999/api/watches');
      expect(url.searchParams.get('watcher')).toBe('self-1');
      expect(url.searchParams.get('target')).toBe('self-1');
    });

    it('fails clearly when DISPATCH_TERMINAL is unset, without calling the daemon', async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as any;
      const out = await callTool('list_watches', {});
      expect(out.isError).toBe(true);
      expect(out.content[0].text).toContain('DISPATCH_TERMINAL');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // --- Task 6 guards: spawn depth, pair rate limit, self-target, archive protection ---

  describe('spawn depth guard (spawn_agent / queue_agent)', () => {
    it('spawn_agent refuses at max depth and never calls the daemon', async () => {
      process.env.DISPATCH_SPAWN_DEPTH = '3'; // exactly at MAX_SPAWN_DEPTH
      const fetchMock = vi.fn();
      global.fetch = fetchMock as any;
      const out = await callTool('spawn_agent', { agentType: 'researcher', task: 'go deeper' });
      expect(out.isError).toBe(true);
      expect(out.content[0].text.toLowerCase()).toContain('depth');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('spawn_agent allows one below the cap and stamps spawnDepth = parent + 1 on the child', async () => {
      process.env.DISPATCH_SPAWN_DEPTH = '2'; // one below MAX_SPAWN_DEPTH (3)
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'deep-1', label: 'researcher agent' }) })
        .mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
      global.fetch = fetchMock as any;
      const out = await callTool('spawn_agent', { agentType: 'researcher', task: 'go deeper' });
      expect(out.isError).toBeUndefined();
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).config.spawnDepth).toBe(3);
    });

    it('queue_agent refuses at max depth and never calls the daemon', async () => {
      process.env.DISPATCH_SPAWN_DEPTH = '3';
      const fetchMock = vi.fn();
      global.fetch = fetchMock as any;
      const out = await callTool('queue_agent', { agentType: 'researcher', task: 'go deeper' });
      expect(out.isError).toBe(true);
      expect(out.content[0].text.toLowerCase()).toContain('depth');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a caller with no DISPATCH_SPAWN_DEPTH set is treated as depth 0 (root) and its child is stamped depth 1', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'root-child', label: 'researcher agent' }) })
        .mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
      global.fetch = fetchMock as any;
      await callTool('spawn_agent', { agentType: 'researcher', task: 'x' });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).config.spawnDepth).toBe(1);
    });
  });

  describe('pair rate limit guard (message_agent / message_thread)', () => {
    it('message_agent allows the 10th message to a target and refuses the 11th', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
      global.fetch = fetchMock as any;
      for (let i = 0; i < 10; i++) {
        const out = await callTool('message_agent', { agentId: 'rl-target-agent', text: `msg ${i}` });
        expect(out.isError).toBeUndefined();
      }
      const eleventh = await callTool('message_agent', { agentId: 'rl-target-agent', text: 'msg 11' });
      expect(eleventh.isError).toBe(true);
      expect(eleventh.content[0].text.toLowerCase()).toContain('rate limit');
      expect(fetchMock).toHaveBeenCalledTimes(10); // the 11th never hit the network
    });

    it('message_thread shares the same limiter keyed on (sender, target) as message_agent', async () => {
      // Genuinely cross-tool: same (sender, target) pair split across BOTH tools — 5 sent
      // via message_agent, 5 via message_thread. If the limiter were per-tool (not shared),
      // both would still be under their own 10-cap and the 11th (from either tool) would
      // wrongly succeed. Asserting it's refused proves one shared counter, not two.
      process.env.DISPATCH_TERMINAL = 'self-cross-tool';
      const fetchMock = vi.fn()
        // message_thread does an assertInProject GET before each message POST; message_agent
        // has no GET, so this generic 200 body (with a matching sessionId) is safe for both.
        .mockResolvedValue({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ id: 'cross-target-shared', sessionId: 'sess-1' }) });
      global.fetch = fetchMock as any;
      for (let i = 0; i < 5; i++) {
        const out = await callTool('message_agent', { agentId: 'cross-target-shared', text: `msg ${i}` });
        expect(out.isError).toBeUndefined();
      }
      for (let i = 5; i < 10; i++) {
        const out = await callTool('message_thread', { id: 'cross-target-shared', text: `msg ${i}` });
        expect(out.isError).toBeUndefined();
      }
      // The 11th overall, sent via message_thread, must be refused...
      const eleventh = await callTool('message_thread', { id: 'cross-target-shared', text: 'msg 11' });
      expect(eleventh.isError).toBe(true);
      expect(eleventh.content[0].text.toLowerCase()).toContain('rate limit');
      // ...and so must the next one via message_agent — same pair, same shared counter.
      const twelfth = await callTool('message_agent', { agentId: 'cross-target-shared', text: 'msg 12' });
      expect(twelfth.isError).toBe(true);
      expect(twelfth.content[0].text.toLowerCase()).toContain('rate limit');
    });
  });

  describe('self-target guard (watch_thread / message_* / complete_agent)', () => {
    it('message_agent refuses to message itself', async () => {
      process.env.DISPATCH_TERMINAL = 'self-x';
      const fetchMock = vi.fn();
      global.fetch = fetchMock as any;
      const out = await callTool('message_agent', { agentId: 'self-x', text: 'hi' });
      expect(out.isError).toBe(true);
      expect(out.content[0].text.toLowerCase()).toContain('yourself');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('message_thread refuses to message itself', async () => {
      process.env.DISPATCH_TERMINAL = 'self-x';
      const fetchMock = vi.fn();
      global.fetch = fetchMock as any;
      const out = await callTool('message_thread', { id: 'self-x', text: 'hi' });
      expect(out.isError).toBe(true);
      expect(out.content[0].text.toLowerCase()).toContain('yourself');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('watch_thread refuses to watch itself', async () => {
      process.env.DISPATCH_TERMINAL = 'self-x';
      const fetchMock = vi.fn();
      global.fetch = fetchMock as any;
      const out = await callTool('watch_thread', { id: 'self-x', when: 'idle' });
      expect(out.isError).toBe(true);
      expect(out.content[0].text.toLowerCase()).toContain('yourself');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('complete_agent refuses to complete itself', async () => {
      process.env.DISPATCH_TERMINAL = 'self-x';
      const fetchMock = vi.fn();
      global.fetch = fetchMock as any;
      const out = await callTool('complete_agent', { agentId: 'self-x' });
      expect(out.isError).toBe(true);
      expect(out.content[0].text.toLowerCase()).toContain('yourself');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('complete_agent archive protection', () => {
    it('refuses to archive a plain (role-less) thread without force', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ id: 'p1', config: {} }),
      });
      global.fetch = fetchMock as any;
      const out = await callTool('complete_agent', { agentId: 'p1' });
      expect(out.isError).toBe(true);
      expect(out.content[0].text.toLowerCase()).toContain('force');
      expect(fetchMock).toHaveBeenCalledTimes(1); // role lookup only — no DELETE
    });

    it('archives a plain (role-less) thread when force:true is passed', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ id: 'p1', config: {} }) })
        .mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
      global.fetch = fetchMock as any;
      const out = await callTool('complete_agent', { agentId: 'p1', force: true });
      expect(out.isError).toBeUndefined();
      expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
    });

    it('archives a typed agent (role set) without force', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ id: 'a1', config: { role: 'coordinator' } }) })
        .mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
      global.fetch = fetchMock as any;
      const out = await callTool('complete_agent', { agentId: 'a1' });
      expect(out.isError).toBeUndefined();
      expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
    });
  });

  it('complete_agent tool schema exposes a force flag defaulting to false-ish behavior', async () => {
    const tool = TOOLS.find((t) => t.name === 'complete_agent') as any;
    expect(tool.inputSchema.properties.force).toBeTruthy();
    expect(tool.inputSchema.required).toEqual(['agentId']); // force is optional
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
