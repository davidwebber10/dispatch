// packages/core/tests/structured/subagents-claude.test.ts
//
// subagents-v1, Claude Code: the REAL frames of Claude Code 2.1.323 (recorded 2026-11-12, see
// tests/fixtures/subagents/claude-subagent-*.jsonl) replayed through the real manager by
// fake-claude-replay.mjs. Proves the subagent list and states, the lifecycle frames, the held idle
// (the thread stays working while a background agent runs), a subagent's approval, and stop_task.
import { it, expect, beforeEach, afterEach, describe } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeStructuredSessionManager } from '../../src/structured/manager.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, 'fake-claude-replay.mjs');
const fixture = (name: string) => path.join(here, '..', 'fixtures', 'subagents', `claude-subagent-${name}.jsonl`);

let m: ClaudeStructuredSessionManager;
beforeEach(() => { m = new ClaudeStructuredSessionManager(); m.subagentReleaseMs = 100; });
afterEach(() => { m.killAll(); });

function spawnReplay(id: string, name: string, opts: { escalate?: boolean } = {}) {
  m.spawn(id, { command: process.execPath, args: [fake], workDir: process.cwd(), env: { FAKE_CLAUDE_REPLAY: fixture(name) }, escalate: opts.escalate });
}

/** Every event of the thread and every edge of the manager, in order. */
function record(id: string) {
  const log: Array<{ edge: string; event?: any; detail?: any }> = [];
  for (const edge of ['event', 'busy', 'idle', 'needs-help', 'permission', 'resolved', 'failed']) {
    m.on(edge, (tid: string, arg: any) => { if (tid === id) log.push(edge === 'event' ? { edge, event: arg } : { edge, detail: arg }); });
  }
  return log;
}

async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const frames = (log: ReturnType<typeof record>) => log.filter((l) => l.edge === 'event' && l.event?.type === 'system' && l.event?.subtype === 'subagent').map((l) => l.event);

describe('Claude Code subagents (recorded frames)', () => {
  it('two parallel agents: listed with their titles, states and figures; a frame per state change; no frame of theirs is a main reply', async () => {
    const log = record('t1');
    spawnReplay('t1', 'parallel');
    m.sendMessage('t1', 'go');
    await until(() => log.some((l) => l.edge === 'idle'));
    const agents = m.listSubagents('t1')!;
    expect(agents.map((a) => a.title)).toEqual(['Count files A', 'Count files B']);
    for (const a of agents) {
      expect(a.state).toBe('done');
      expect(a.harness).toBe('claude-code');
      expect(a.parentId).toBeNull();
      expect(a.kind).toBe('general-purpose');
      expect(a.background).toBe(true); // the CLI ran both in the background (async_launched)
      expect(a.nativeId).toMatch(/^a[0-9a-f]+$/);
      expect(a.tokens).toBeGreaterThan(0);
      expect(a.steps).toBe(1);
      expect(a.model).toBe('claude-haiku-5-5');
      expect(a.result).toBeTruthy();
    }
    expect(agents[0].result).toContain('2 entries');
    const fs = frames(log);
    // starting → working → done, for each agent; ids are the Agent call ids.
    for (const a of agents) expect(fs.filter((f) => f.id === a.id).map((f) => f.state)).toEqual(['starting', 'working', 'done']);
    // The main turn ended while both agents ran: its idle came only after both were done.
    const idleAt = log.findIndex((l) => l.edge === 'idle');
    const lastDone = Math.max(...agents.map((a) => log.findIndex((l) => l.edge === 'event' && l.event?.subtype === 'subagent' && l.event.id === a.id && l.event.state === 'done')));
    const resultAt = log.findIndex((l) => l.edge === 'event' && l.event?.type === 'result');
    expect(resultAt).toBeLessThan(lastDone);
    expect(idleAt).toBeGreaterThan(lastDone);
    expect(log.filter((l) => l.edge === 'idle')).toHaveLength(1);
    // The turn texts are the main agent's only.
    expect(m.getTurnTexts('t1')!.join(' ')).not.toContain('2 entries');
  });

  it('a background agent: the thread stays working after the main result; the CLI wakes its main agent with the result and only that turn settles', async () => {
    const log = record('t2');
    spawnReplay('t2', 'background');
    m.sendMessage('t2', 'go');
    await until(() => log.filter((l) => l.edge === 'event' && l.event?.type === 'result').length === 2 && log.some((l) => l.edge === 'idle'));
    const [a] = m.listSubagents('t2')!;
    expect(a).toMatchObject({ title: 'Background count', state: 'done', background: true });
    const firstResult = log.findIndex((l) => l.edge === 'event' && l.event?.type === 'result');
    const idles = log.map((l, i) => (l.edge === 'idle' ? i : -1)).filter((i) => i >= 0);
    // No idle at the first result (the agent ran), one idle at the end of the wake turn.
    expect(idles).toHaveLength(1);
    expect(idles[0]).toBeGreaterThan(firstResult);
    const secondResult = log.map((l, i) => (l.edge === 'event' && l.event?.type === 'result' ? i : -1)).filter((i) => i >= 0).pop()!;
    expect(idles[0]).toBeGreaterThan(secondResult);
  });

  it('a subagent asks: the pending names the subagent, the subagent needs the person, an answer lets it work on', async () => {
    const log = record('t3');
    spawnReplay('t3', 'permission', { escalate: true });
    m.sendMessage('t3', 'go');
    await until(() => !!m.getPending('t3'));
    const pending = m.getPending('t3')!;
    const [a] = m.listSubagents('t3')!;
    expect(pending.toolName).toBe('Bash');
    expect(pending.agentId).toBe(a.id);
    expect(a.state).toBe('needs_input');
    expect(log.find((l) => l.edge === 'permission')?.detail.agentId).toBe(a.id);
    expect(m.answerPermission('t3', pending.requestId, { behavior: 'allow' })).toBe(true);
    await until(() => log.some((l) => l.edge === 'idle'));
    expect(frames(log).filter((f) => f.id === a.id).map((f) => f.state)).toEqual(['starting', 'working', 'needs_input', 'working', 'done']);
    expect(m.listSubagents('t3')![0]).toMatchObject({ state: 'done', tokens: 12700, steps: 1, model: 'claude-haiku-5-5' });
  });

  for (const kind of ['background', 'foreground'] as const) {
    it(`stop one ${kind} agent: stop_task with the CLI's agent id; the agent ends stopped`, async () => {
      const log = record('t4');
      spawnReplay('t4', `stop-${kind}`);
      m.sendMessage('t4', 'go');
      await until(() => m.listSubagents('t4')?.[0]?.state === 'working' && !!m.listSubagents('t4')?.[0]?.nativeId);
      const [a] = m.listSubagents('t4')!;
      expect(await m.stopSubagent('t4', a.id)).toBe('stopped');
      expect(m.listSubagents('t4')![0].state).toBe('stopped');
      expect(await m.stopSubagent('t4', a.id)).toBe('not-running');
      expect(await m.stopSubagent('t4', 'no-such-agent')).toBe('not-found');
      // The CLI then wakes its main agent about the stop; that turn settles (the model may end on a question).
      await until(() => log.some((l) => l.edge === 'idle' || l.edge === 'needs-help'));
      expect(frames(log).filter((f) => f.id === a.id).map((f) => f.state)).toEqual(['starting', 'working', 'stopped']);
    });
  }
});
