import { describe, it, expect, vi, afterEach } from 'vitest';
import { createWorker, sendTask, readAgentOutput, AGENT_TYPES, HARNESSES } from '../../src/overseer/agency-shared.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const origSession = process.env.DISPATCH_SESSION;
afterEach(() => {
  vi.unstubAllGlobals();
  if (origSession === undefined) delete process.env.DISPATCH_SESSION; else process.env.DISPATCH_SESSION = origSession;
});

describe('agency-shared', () => {
  it('createWorker resolves the defaults and creates the thread in the given project, never DISPATCH_SESSION', async () => {
    process.env.DISPATCH_SESSION = 'other-project';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { harness: 'claude-code', model: 'sonnet', available: true }))
      .mockResolvedValueOnce(json(201, { id: 't9' }));
    vi.stubGlobal('fetch', fetchMock);
    const id = await createWorker('http://d', 's9', { agentType: 'implementer', label: 'Fix login', mission: '', model: '', harness: '', spawnDepth: 1, origin: 'endless' });
    expect(id).toBe('t9');
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://d/api/sessions/s9/overseer/worker-defaults?agentType=implementer');
    expect(String(fetchMock.mock.calls[1][0])).toBe('http://d/api/sessions/s9/terminals');
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual({
      type: 'claude-code', label: 'Fix login',
      config: { transport: 'structured', agentType: 'implementer', role: 'agent', model: 'sonnet', spawnDepth: 1, origin: 'endless' },
    });
  });

  it('createWorker refuses an unavailable harness before it creates anything', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(200, { harness: 'codex', available: false, reason: 'codex is not signed in' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createWorker('http://d', 's9', { agentType: 'researcher', label: 'r', mission: '', model: '', harness: 'codex', spawnDepth: 1 }))
      .rejects.toThrow('codex is not signed in');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sendTask posts the task as a coordinator message', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await sendTask('http://d', 't9', 'do it');
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://d/api/terminals/t9/message');
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ text: 'do it', source: 'coordinator' });
  });

  it('readAgentOutput joins the assistant text and reads the status', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json(200, { items: [{ kind: 'assistant', text: 'one' }, { kind: 'tool', toolName: 'Read' }, { kind: 'assistant', text: 'two' }] }))
      .mockResolvedValueOnce(json(200, { status: 'waiting' })));
    const r = await readAgentOutput('http://d', 't9');
    expect(r).toEqual({ agentId: 't9', status: 'waiting', output: expect.any(String), tools: ['Read'] });
    // The agent's words are data: they come back inside one marked block.
    expect(r.output).toMatch(/^\[\[\[UNTRUSTED ([0-9a-f]{16}) from agent t9[^\n]*\n+one\n\ntwo\n\[\[\[END UNTRUSTED \1\]\]\]$/);
  });

  it('readAgentOutput encodes the agent id in both requests', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { items: [] }))
      .mockResolvedValueOnce(json(200, { status: 'waiting' }));
    vi.stubGlobal('fetch', fetchMock);
    await readAgentOutput('http://d', 'a/b?c');
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      'http://d/api/terminals/a%2Fb%3Fc/conversation?limit=500',
      'http://d/api/terminals/a%2Fb%3Fc',
    ]);
  });

  it('lists the agent types and harnesses the schemas use', () => {
    expect(AGENT_TYPES).toEqual(['planner', 'implementer', 'researcher', 'reviewer', 'design-reviewer', 'code-reviewer']);
    expect(HARNESSES).toEqual(['claude-code', 'codex', 'grok', 'opencode']);
  });
});
