// The decision-ledger tools (structured-recap spec, Unit 3) and the `ledgerIds` hand-off on
// spawn_agent / queue_agent / message_agent. fetch is mocked, as in agency-mcp.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { callTool, TOOLS } from '../../src/overseer/agency-mcp.js';

const ok = (body: unknown, status = 200) => ({ ok: true, status, statusText: 'OK', text: async () => (body === undefined ? '' : JSON.stringify(body)) });
const fail = (status: number, error: string) => ({ ok: false, status, statusText: 'Err', text: async () => JSON.stringify({ error }) });
const BLOCK = 'Owner decisions (verbatim, from the ledger):\n- N7 [Go] Merge PR #12.\n  You approved: "Merge PR #12." → "merge N7" (Mon 16:51)';

describe('agency-mcp ledger tools', () => {
  const saved = { ...process.env };
  const origFetch = global.fetch;
  beforeEach(() => {
    process.env.DISPATCH_API = 'http://localhost:9999';
    process.env.DISPATCH_SESSION = 'sess-1';
    process.env.DISPATCH_TERMINAL = 'coord-1';
    delete process.env.DISPATCH_SPAWN_DEPTH;
  });
  afterEach(() => {
    global.fetch = origFetch;
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it('ledger_add POSTs the item with the caller identity and returns { id, line }', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok({ id: 'N8', line: 'N8 [Decide] Which store? (open 0m)\n  Proposed by overseer, not approved' }, 201));
    global.fetch = fetchMock as any;
    const out = await callTool('ledger_add', { kind: 'decide', text: 'Which store?', options: ['A', 'B'], caller: 'someone-else' });
    expect(out.isError).toBeUndefined();
    expect(JSON.parse((out.content[0] as any).text)).toEqual({ id: 'N8', line: 'N8 [Decide] Which store? (open 0m)\n  Proposed by overseer, not approved' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:9999/api/sessions/sess-1/ledger');
    expect(JSON.parse(init.body)).toEqual({ kind: 'decide', text: 'Which store?', options: ['A', 'B'], caller: 'coord-1' }); // caller is always self
  });

  it('ledger_resolve POSTs to the item route and surfaces the route error text as is', async () => {
    const msg = "Quote not found in the user's messages to you after N12 was created. Do not record it. Ask the user.";
    const fetchMock = vi.fn().mockResolvedValueOnce(fail(422, msg));
    global.fetch = fetchMock as any;
    const out = await callTool('ledger_resolve', { id: 'N12', status: 'answered', quote: 'yes' });
    expect(out.isError).toBe(true);
    expect((out.content[0] as any).text).toBe(`Error: ${msg}`);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:9999/api/sessions/sess-1/ledger/N12/resolve');
    expect(JSON.parse(init.body)).toEqual({ status: 'answered', quote: 'yes', caller: 'coord-1' });
  });

  it('ledger_note and ledger_import POST to their routes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ id: 'N3', line: 'N3 You said: "never on Fridays" (Mon 16:51)' }, 201))
      .mockResolvedValueOnce(ok({ ids: ['N4'] }, 201));
    global.fetch = fetchMock as any;
    await callTool('ledger_note', { quote: 'never on Fridays' });
    await callTool('ledger_import', { items: [{ kind: 'go', text: 'Merge PR #9.' }] });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/api/sessions/sess-1/ledger/note');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ quote: 'never on Fridays', caller: 'coord-1' });
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:9999/api/sessions/sess-1/ledger/import');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ caller: 'coord-1', items: [{ kind: 'go', text: 'Merge PR #9.' }] });
  });

  it('ledger_list returns the rendered text itself, not a JSON string', async () => {
    const text = 'Needs you now:\n- none\n\nYour tests and actions:\n- none';
    const fetchMock = vi.fn().mockResolvedValueOnce(ok({ text, openIds: [] }));
    global.fetch = fetchMock as any;
    const out = await callTool('ledger_list', { forRecap: true });
    expect(out.content).toEqual([{ type: 'text', text }]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ caller: 'coord-1', forRecap: true });
  });

  it('each of the five ledger tools surfaces the daemon\'s overseer-only refusal (403) as is', async () => {
    const denied = "Only the project's overseer can change the ledger.";
    const calls: [string, Record<string, unknown>][] = [
      ['ledger_add', { kind: 'go', text: 'Merge PR #12.' }],
      ['ledger_resolve', { id: 'N1', status: 'withdrawn', reason: 'moot' }],
      ['ledger_note', { quote: 'never on Fridays' }],
      ['ledger_list', { forRecap: true }],
      ['ledger_import', { items: [{ kind: 'do', text: 'Check staging.' }] }],
    ];
    for (const [tool, args] of calls) {
      const fetchMock = vi.fn().mockResolvedValueOnce(fail(403, denied));
      global.fetch = fetchMock as any;
      const out = await callTool(tool, args);
      expect(fetchMock, tool).toHaveBeenCalledTimes(1);
      expect(out.isError, tool).toBe(true);
      expect(out.content, tool).toEqual([{ type: 'text', text: `Error: ${denied}` }]);
    }
  });

  it('a ledger tool fails clearly without a caller identity and never calls the daemon', async () => {
    delete process.env.DISPATCH_TERMINAL;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;
    const out = await callTool('ledger_list', {});
    expect(out.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('spawn_agent with ledgerIds fetches the hand-off block first and appends it to the task', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ block: BLOCK }))
      .mockResolvedValueOnce(ok({ harness: 'claude-code', available: true }))
      .mockResolvedValueOnce(ok({ id: 'agent-1', label: 'implementer agent' }, 201))
      .mockResolvedValueOnce(ok(undefined, 204));
    global.fetch = fetchMock as any;
    const out = await callTool('spawn_agent', { agentType: 'implementer', task: 'merge the PR', ledgerIds: ['N7'] });
    expect(out.isError).toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/api/sessions/sess-1/ledger/handoff');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ caller: 'coord-1', ids: ['N7'] });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ text: `merge the PR\n\n${BLOCK}`, source: 'coordinator' });
  });

  it('spawn_agent with an unknown ledger ID fails before any thread exists', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(fail(404, 'Unknown ledger item: N99'));
    global.fetch = fetchMock as any;
    const out = await callTool('spawn_agent', { agentType: 'implementer', task: 'x', ledgerIds: ['N99'] });
    expect(out.isError).toBe(true);
    expect((out.content[0] as any).text).toBe('Error: Unknown ledger item: N99');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('queue_agent parks the task with the block appended', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ block: BLOCK }))
      .mockResolvedValueOnce(ok({ harness: 'claude-code', available: true }))
      .mockResolvedValueOnce(ok({ id: 'q1', label: 'implementer agent' }, 201));
    global.fetch = fetchMock as any;
    await callTool('queue_agent', { agentType: 'implementer', task: 'merge later', ledgerIds: ['N7'] });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).task).toBe(`merge later\n\n${BLOCK}`);
  });

  it('message_agent sends the text with the block appended', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ block: BLOCK }))
      .mockResolvedValueOnce(ok(undefined, 204));
    global.fetch = fetchMock as any;
    await callTool('message_agent', { agentId: 'a1', text: 'go ahead', ledgerIds: ['N7'] });
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:9999/api/terminals/a1/message');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ text: `go ahead\n\n${BLOCK}`, source: 'coordinator' });
  });

  it('spawn_agent, queue_agent and message_agent declare ledgerIds in their schemas', () => {
    for (const name of ['spawn_agent', 'queue_agent', 'message_agent']) {
      const tool = TOOLS.find((t) => t.name === name)! as any;
      expect(tool.inputSchema.properties.ledgerIds.type).toBe('array');
    }
  });
});
