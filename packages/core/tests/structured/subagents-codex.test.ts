// packages/core/tests/structured/subagents-codex.test.ts
//
// subagents-v1, Codex: a sub-thread's frames reach the thread that owns it (tagged with the
// sub-thread id), its life is one `system/subagent` frame per state change, its approvals surface
// like the main thread's (never answered with an error), the thread stays working while it runs,
// a finished subagent's result starts a main turn when the main agent is idle, and a stop
// interrupts the sub-thread's turn. Driven through the real manager with fake-codex-app-server.mjs.
import { it, expect, beforeEach, afterEach, describe } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexStructuredSessionManager } from '../../src/structured/codex-manager.js';
import { isTaskNotification } from '../../src/conversation/task-notification.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, 'fake-codex-app-server.mjs');
const fixture = (name: string) => path.join(here, '..', 'fixtures', 'subagents', name);

let m: CodexStructuredSessionManager;
let logPath: string;
beforeEach(() => {
  m = new CodexStructuredSessionManager();
  logPath = path.join(os.tmpdir(), `codex-sub-log-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ndjson`);
});
afterEach(() => { m.killAll(); fs.rmSync(logPath, { force: true }); });

function spawn(id: string, opts: { escalate?: boolean } = {}) {
  m.spawn(id, { command: process.execPath, args: [fake], workDir: process.cwd(), env: { CODEX_FAKE_LOG: logPath }, escalate: opts.escalate });
}

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

const fakeLog = (): any[] => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const turnTexts = () => fakeLog().filter((e) => e.method === 'turn/start:text').map((e) => e.params);
const frames = (log: ReturnType<typeof record>) => log.filter((l) => l.edge === 'event' && l.event?.type === 'system' && l.event?.subtype === 'subagent').map((l) => l.event);
const SUB = 'sub-thread-1';

describe('Codex subagents', () => {
  it('routes the sub-thread to its thread, tagged; keeps the thread working; delivers the result in an internal main turn', async () => {
    const log = record('c1');
    spawn('c1');
    m.sendMessage('c1', 'subagent basic');
    await until(() => turnTexts().length === 2 && log.some((l) => l.edge === 'idle'));
    const [a] = m.listSubagents('c1')!;
    expect(a).toMatchObject({
      id: SUB, harness: 'codex', parentId: null, title: 'Review the files', kind: 'reviewer',
      model: 'gpt-fake-sub', effort: 'medium', state: 'done', result: 'The files have two issues.',
      tokens: 300, usage: { input: 250, output: 50 }, steps: 1, callId: 'call_sa_1', nativeId: '/root/review_the_files',
    });
    expect(frames(log).map((f) => f.state)).toEqual(['starting', 'working', 'done']);
    // Every sub-thread frame is tagged with the sub-thread id; none of them is untagged.
    const subEvents = log.filter((l) => l.edge === 'event' && l.event?.parent_tool_use_id === SUB).map((l) => l.event);
    expect(subEvents.some((e) => e.type === 'assistant' && e.message.content[0]?.type === 'tool_use' && e.message.content[0].name === 'Shell')).toBe(true);
    expect(subEvents.some((e) => e.type === 'stream_event' && e.event?.delta?.text === 'Reading the files.')).toBe(true);
    expect(subEvents.some((e) => e.type === 'result')).toBe(true);
    expect(log.some((l) => l.edge === 'event' && l.event?.parent_tool_use_id == null && JSON.stringify(l.event).includes('Reading the files.'))).toBe(false);
    // The main turn ended while the subagent worked: no idle until the delivered turn ended.
    const firstMainResult = log.findIndex((l) => l.edge === 'event' && l.event?.type === 'result' && l.event.parent_tool_use_id == null);
    const done = log.findIndex((l) => l.edge === 'event' && l.event?.subtype === 'subagent' && l.event.state === 'done');
    const idles = log.map((l, i) => (l.edge === 'idle' ? i : -1)).filter((i) => i >= 0);
    expect(idles).toHaveLength(1);
    expect(idles[0]).toBeGreaterThan(done);
    expect(done).toBeGreaterThan(firstMainResult);
    // The delivery: a main turn whose input is a task-notification block, echoed as internal.
    const delivered = turnTexts()[1];
    expect(delivered.threadId).toBe('thread-fake-1');
    expect(isTaskNotification(delivered.text)).toBe(true);
    expect(delivered.text).toContain(`<tool-use-id>${SUB}</tool-use-id>`);
    expect(delivered.text).toContain('<status>completed</status>');
    expect(delivered.text).toContain('The files have two issues.');
    const echo = log.find((l) => l.edge === 'event' && l.event?.meta?.internal === true)?.event;
    expect(echo).toMatchObject({ type: 'user', meta: { source: 'dispatch', internal: true, subagents: [SUB] } });
  });

  it("a sub-thread's MCP approval surfaces to the person with its subagent, and the answer goes back to the sub-thread", async () => {
    const log = record('c2');
    spawn('c2', { escalate: true });
    m.sendMessage('c2', 'subagent approval');
    await until(() => !!m.getPending('c2'));
    const pending = m.getPending('c2')!;
    expect(pending).toMatchObject({ toolName: 'mcp__company__lookup', agentId: SUB });
    expect(m.listSubagents('c2')![0].state).toBe('needs_input');
    // Not refused: no error response went back to the app-server.
    expect(fakeLog().some((e) => e.response === 'mcpServer/elicitation/request')).toBe(false);
    expect(m.answerPermission('c2', pending.requestId, { behavior: 'allow' })).toBe(true);
    await until(() => m.listSubagents('c2')![0].state === 'done');
    const answer = fakeLog().find((e) => e.response === 'mcpServer/elicitation/request');
    expect(answer.result).toMatchObject({ action: 'accept' });
    expect(frames(log).map((f) => f.state)).toEqual(['starting', 'working', 'needs_input', 'working', 'done']);
    expect(m.listSubagents('c2')![0].result).toBe('The lookup found it.');
  });

  it("a sub-thread's approval runs through the thread's policy first (a deny never reaches the person)", async () => {
    m.spawn('c3', {
      command: process.execPath, args: [fake], workDir: process.cwd(), env: { CODEX_FAKE_LOG: logPath }, escalate: true,
      toolPolicy: (tool) => (tool.includes('company') ? { allow: false, message: 'not for this thread' } : { allow: true }),
    });
    m.sendMessage('c3', 'subagent approval');
    await until(() => m.listSubagents('c3')?.[0]?.state === 'done');
    expect(m.getPending('c3')).toBeNull();
    expect(fakeLog().find((e) => e.response === 'mcpServer/elicitation/request')?.result).toMatchObject({ action: 'decline' });
    const denied = m.getEvents('c3').find((e: any) => e.parent_tool_use_id === SUB && e.type === 'user' && e.message?.content?.[0]?.is_error === true) as any;
    expect(denied.message.content[0].content).toBe('not for this thread');
  });

  it('stop one: turn/interrupt on the sub-thread; the subagent ends stopped and its result is not delivered', async () => {
    const log = record('c4');
    spawn('c4');
    m.sendMessage('c4', 'subagent slow');
    await until(() => m.listSubagents('c4')?.[0]?.state === 'working');
    expect(await m.stopSubagent('c4', SUB)).toBe('stopped');
    expect(fakeLog().find((e) => e.method === 'turn/interrupt')?.params).toEqual({ threadId: SUB, turnId: 'turn-sub-1' });
    await until(() => log.some((l) => l.edge === 'idle'));
    expect(m.listSubagents('c4')![0].state).toBe('stopped');
    expect(turnTexts()).toHaveLength(1); // no delivery turn
    expect(await m.stopSubagent('c4', SUB)).toBe('not-running');
    expect(await m.stopSubagent('c4', 'nope')).toBe('not-found');
  });

  it('stop all: every running subagent and the main turn', async () => {
    spawn('c5');
    m.sendMessage('c5', 'subagent slow');
    await until(() => m.listSubagents('c5')?.[0]?.state === 'working');
    const out = await m.stopAllSubagents('c5');
    expect(out).toEqual({ stopped: [SUB], unsupported: [], mainInterrupted: false });
  });

  it('the subAgentActivity kinds and the collab tool states (fixture): started, interacted, interrupted; spawnAgent, listAgents, wait', async () => {
    const log = record('c6');
    spawn('c6');
    m.sendMessage('c6', `replay-file ${fixture('codex-subagent-kinds.jsonl')}`);
    await until(() => log.some((l) => l.edge === 'idle'));
    const agents = m.listSubagents('c6')!;
    expect(agents.map((a) => [a.id, a.title, a.state])).toEqual([
      ['019a0000-0000-7000-8000-00000000000a', 'Review the notes', 'stopped'],
      ['019a0000-0000-7000-8000-00000000000b', 'Check the build output', 'failed'],
    ]);
    expect(agents[0]).toMatchObject({ model: 'gpt-6.1-sol', effort: 'medium', callId: 'call_fake_started', startedAt: 1700000000000 });
    expect(agents[1]).toMatchObject({ model: 'gpt-6.1-luna', effort: 'low', prompt: 'Check the build output\nThen report what failed.', error: 'The build tool is missing.' });
    // The main agent read the failure itself (wait), and the other was stopped: nothing to deliver.
    expect(turnTexts()).toHaveLength(1);
    expect(frames(log).filter((f) => f.id === agents[0].id).map((f) => f.state)).toEqual(['starting', 'working', 'stopped']);
    expect(frames(log).filter((f) => f.id === agents[1].id).map((f) => f.state)).toEqual(['starting', 'working', 'failed']);
  });

  it('a subagent that completes after the main turn ended (fixture): its result starts the main turn', async () => {
    const log = record('c7');
    spawn('c7');
    m.sendMessage('c7', `replay-file ${fixture('codex-subagent-completed.jsonl')}`);
    await until(() => turnTexts().length === 2 && log.some((l) => l.edge === 'idle'));
    expect(m.listSubagents('c7')![0]).toMatchObject({ title: 'Summarise the notes', state: 'done', endedAt: 1700000060000 });
    expect(isTaskNotification(turnTexts()[1].text)).toBe(true);
    expect(log.filter((l) => l.edge === 'idle')).toHaveLength(1);
  });
});
