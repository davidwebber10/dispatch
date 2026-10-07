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

  it('each of the nine ledger tools surfaces the daemon\'s overseer-only refusal (403) as is', async () => {
    const denied = "Only the project's overseer can change the ledger.";
    const calls: [string, Record<string, unknown>][] = [
      ['ledger_add', { kind: 'go', text: 'Merge PR #12.' }],
      ['ledger_resolve', { id: 'N1', status: 'withdrawn', reason: 'moot' }],
      ['ledger_note', { quote: 'never on Fridays' }],
      ['ledger_list', { forRecap: true }],
      ['ledger_import', { items: [{ kind: 'do', text: 'Check staging.' }] }],
      ['ledger_add_from_agent', { id: 'N1' }],
      ['ledger_decide_self', { id: 'N1', choice: 'A', reason: 'x' }],
      ['ledger_mark_default', { id: 'N1' }],
      ['ledger_show', { all: true }],
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

  // Decision cards (spec 2026-10-06, Unit 4).
  it('ledger_add_from_agent, ledger_decide_self and ledger_mark_default POST to their item routes with the caller', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ id: 'N30', status: 'open' }))
      .mockResolvedValueOnce(ok({ id: 'N31', status: 'decided_by_overseer', line: '- **N31 · Decided by overseer:** …' }))
      .mockResolvedValueOnce(ok({ id: 'N9', line: '- **N9 · Decide:** …' }));
    global.fetch = fetchMock as any;
    expect(JSON.parse(((await callTool('ledger_add_from_agent', { id: 'N30', note: 'Mind the freeze.', blocks: 'the deploy' })).content[0] as any).text)).toEqual({ id: 'N30', status: 'open' });
    await callTool('ledger_decide_self', { id: 'N31', choice: 'the existing helper', reason: 'it covers this case' });
    await callTool('ledger_mark_default', { id: 'N9' });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'http://localhost:9999/api/sessions/sess-1/ledger/N30/add-from-agent',
      'http://localhost:9999/api/sessions/sess-1/ledger/N31/decide-self',
      'http://localhost:9999/api/sessions/sess-1/ledger/N9/mark-default',
    ]);
    expect((TOOLS.find((t) => t.name === 'ledger_add_from_agent')! as any).inputSchema.properties.blocks.type).toBe('string');
    expect(fetchMock.mock.calls.map((c) => JSON.parse(c[1].body))).toEqual([
      { note: 'Mind the freeze.', blocks: 'the deploy', caller: 'coord-1' },
      { choice: 'the existing helper', reason: 'it covers this case', caller: 'coord-1' },
      { caller: 'coord-1' },
    ]);
  });

  it('ledger_decide_self without an id records a new decision: it POSTs the card fields to /decide-self', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok({ id: 'N40', status: 'decided_by_overseer', line: '- **N40 · Decided by overseer:** …' }, 201));
    global.fetch = fetchMock as any;
    const args = { text: 'Which retry helper?', context: 'x'.repeat(30), choice: 'the existing helper', reason: 'it covers this case' };
    const out = await callTool('ledger_decide_self', args);
    expect(out.isError).toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/api/sessions/sess-1/ledger/decide-self');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ ...args, caller: 'coord-1' });
  });

  it('ledger_decide_self takes either an id or the question text; the schema says so', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;
    expect((await callTool('ledger_decide_self', { choice: 'A', reason: 'x' })).isError).toBe(true); // neither id nor text
    expect(fetchMock).not.toHaveBeenCalled();
    const tool = TOOLS.find((t) => t.name === 'ledger_decide_self')! as any;
    expect(tool.inputSchema.required).toEqual(['choice', 'reason']);
    expect(Object.keys(tool.inputSchema.properties)).toEqual(expect.arrayContaining(['id', 'text', 'context', 'options', 'recommendation', 'why', 'default', 'source', 'choice', 'reason']));
    expect(tool.inputSchema.properties.kind).toBeUndefined(); // always a decide item
  });

  it('ledger_decide_self surfaces the protected-item refusal as is', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(fail(422, 'Only the user can decide this item.')) as any;
    const out = await callTool('ledger_decide_self', { id: 'N12', choice: 'merge', reason: 'green' });
    expect(out).toEqual({ content: [{ type: 'text', text: 'Error: Only the user can decide this item.' }], isError: true });
  });

  it('ledger_show returns the rendered cards themselves, not a JSON string', async () => {
    const text = '**N17 · Decide:** Keep the old tag check?\n\nHolds up: nothing · Open 2 days';
    const fetchMock = vi.fn().mockResolvedValueOnce(ok({ text }));
    global.fetch = fetchMock as any;
    expect((await callTool('ledger_show', { ids: ['N17'] })).content).toEqual([{ type: 'text', text }]);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/api/sessions/sess-1/ledger/show');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ caller: 'coord-1', ids: ['N17'] });
  });

  it('the new tools check their required arguments before calling the daemon', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;
    for (const [tool, args] of [['ledger_add_from_agent', {}], ['ledger_decide_self', { id: 'N1', choice: 'A' }], ['ledger_mark_default', {}], ['ledger_show', {}]] as const) {
      expect((await callTool(tool, args)).isError, tool).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ledger_add declares the card fields; ledger_note declares policy; ledger_import items take the card fields', () => {
    const props = (name: string) => (TOOLS.find((t) => t.name === name)! as any).inputSchema.properties;
    expect(Object.keys(props('ledger_add'))).toEqual(expect.arrayContaining(['context', 'options', 'recommendation', 'why', 'default', 'source', 'note']));
    expect(props('ledger_add').options.items.properties).toEqual({ label: expect.any(Object), effect: expect.any(Object) });
    expect(props('ledger_add').source.properties.kind.enum).toEqual(['plan', 'doc', 'agent', 'pr', 'issue', 'user', 'overseer']);
    expect(props('ledger_note').policy.type).toBe('boolean');
    expect(Object.keys(props('ledger_import').items.items.properties)).toEqual(expect.arrayContaining(['context', 'options', 'why', 'default', 'source']));
  });
});
