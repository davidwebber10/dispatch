// packages/core/tests/structured/subagents-review.test.ts
//
// subagents-v1: the review findings of 2026-11-12, each as a test that fails on the first version of
// the feature (the proof scripts of the review, made repo tests). Codex through fake-codex-app-server.mjs
// (and fake-codex-loop-app-server.mjs), Claude through the recorded frames or fake-claude-two-requests.mjs.
import { it, expect, afterEach, describe } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexStructuredSessionManager } from '../../src/structured/codex-manager.js';
import { ClaudeStructuredSessionManager } from '../../src/structured/manager.js';
import type { IStructuredManager } from '../../src/structured/manager.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, 'fake-codex-app-server.mjs');
const loopFake = path.join(here, 'fake-codex-loop-app-server.mjs');
const replay = path.join(here, 'fake-claude-replay.mjs');
const twoRequests = path.join(here, 'fake-claude-two-requests.mjs');
const caseFile = (name: string) => path.join(here, '..', 'fixtures', 'subagents', 'cases', `codex-${name}.jsonl`);
const claudeFixture = (name: string) => path.join(here, '..', 'fixtures', 'subagents', `claude-subagent-${name}.jsonl`);

const managers: IStructuredManager[] = [];
const files: string[] = [];
afterEach(() => { for (const m of managers.splice(0)) m.killAll(); for (const f of files.splice(0)) fs.rmSync(f, { force: true }); });

const tmpLog = (tag: string) => { const p = path.join(os.tmpdir(), `sub-review-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ndjson`); files.push(p); return p; };
const readLog = (p: string): any[] => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await sleep(20);
  }
}

function codex(opts: { lostAfterMs?: number } = {}) {
  const m = new CodexStructuredSessionManager();
  if (opts.lostAfterMs) m.subagentLostAfterMs = opts.lostAfterMs;
  managers.push(m);
  const log = tmpLog('codex');
  const edges: Record<string, Array<{ e: string; arg: any }>> = {};
  for (const e of ['idle', 'busy', 'event', 'needs-help', 'failed']) m.on(e, (tid: string, arg: any) => { (edges[tid] ??= []).push({ e, arg }); });
  const spawn = (id: string, resumeId?: string, extra: Record<string, unknown> = {}) =>
    m.spawn(id, { command: process.execPath, args: [fake], workDir: process.cwd(), env: { CODEX_FAKE_LOG: log }, ...(resumeId ? { resumeId } : {}), ...extra });
  const turns = (thread?: string) => readLog(log).filter((x) => x.method === 'turn/start:text' && (!thread || x.params.threadId === thread)).map((x) => x.params.text as string);
  const count = (tid: string, e: string) => (edges[tid] ?? []).filter((x) => x.e === e).length;
  const nonEvent = (tid: string) => (edges[tid] ?? []).filter((x) => x.e !== 'event').map((x) => x.e);
  return { m, log, edges, spawn, turns, count, nonEvent };
}

describe('H2: the turns the daemon starts by itself are capped', () => {
  it('a main agent that starts a subagent in every turn gets 3 automatic turns, then one notice, and the thread goes idle', async () => {
    const m = new CodexStructuredSessionManager();
    managers.push(m);
    const loopLog = tmpLog('loop');
    let idles = 0;
    const notices: string[] = [];
    m.on('idle', () => { idles += 1; });
    m.on('event', (_t: string, e: any) => { if (e?.subtype === 'dispatch_notice') notices.push(e.message); });
    m.spawn('L', { command: process.execPath, args: [loopFake], workDir: process.cwd(), env: { LOOP_LOG: loopLog } });
    m.sendMessage('L', 'start working', 'user');
    await until(() => idles > 0);
    await sleep(300);
    const turns = readLog(loopLog);
    expect(turns).toHaveLength(4); // the person's turn + 3
    expect(turns.filter((t) => t.internal)).toHaveLength(3);
    expect(notices).toEqual(['Agents finished; ask to see their results.']);
    expect(idles).toBe(1);
    // The person's next message starts a new run: one more automatic turn may follow it.
    m.sendMessage('L', 'and the results?', 'user');
    await until(() => readLog(loopLog).length >= 6);
  });
});

describe('H3: a held idle has a time limit', () => {
  it('Codex: a subagent with no frame for the limit is lost; the thread goes idle', async () => {
    const c = codex({ lostAfterMs: 300 });
    c.spawn('h3');
    c.m.sendMessage('h3', 'subagent slow');
    await until(() => c.m.listSubagents('h3')?.[0]?.state === 'working');
    await until(() => c.count('h3', 'idle') === 1, 5000);
    expect(c.m.listSubagents('h3')![0]).toMatchObject({ state: 'lost', error: expect.stringMatching(/No word from the subagent/) });
  });

  it('Claude: a background agent that goes silent after the main turn ended is lost; the thread goes idle', async () => {
    const m = new ClaudeStructuredSessionManager();
    m.subagentLostAfterMs = 300;
    managers.push(m);
    let idle = 0;
    m.on('idle', () => { idle += 1; });
    // The recording waits (for a stop_task that never comes) with its agent working and the main turn over.
    m.spawn('h3c', { command: process.execPath, args: [replay], workDir: process.cwd(), env: { FAKE_CLAUDE_REPLAY: claudeFixture('stop-background') } });
    m.sendMessage('h3c', 'go');
    await until(() => idle === 1, 5000);
    expect(m.listSubagents('h3c')![0].state).toBe('lost');
  });
});

describe('M1: stop stops', () => {
  it('a: after the person stops the reply, no turn starts by itself', async () => {
    const c = codex();
    c.spawn('e', 'thread-E');
    c.m.sendMessage('e', `replay-file ${caseFile('e1')}`);
    await until(() => c.m.listSubagents('e')?.[0]?.state === 'done');
    expect(c.m.interrupt('e')).toBe(true);
    await until(() => c.count('e', 'idle') === 1);
    await sleep(300);
    expect(c.turns('thread-E')).toHaveLength(1);
    // The next message of the person goes, and the waiting result is handed over at its end.
    c.m.sendMessage('e', 'go on', 'user');
    await until(() => c.turns('thread-E').length === 3);
    expect(c.turns('thread-E')[2]).toContain('sub result text');
  });

  it('b: a stop before the first turn of the subagent interrupts that turn when it starts, and the subagent stays stopped', async () => {
    const c = codex();
    c.spawn('f', 'thread-F');
    c.m.sendMessage('f', `replay-file ${caseFile('f1')}`);
    await until(() => c.m.listSubagents('f')?.[0]?.state === 'starting');
    expect(await c.m.stopSubagent('f', 'sub-W')).toBe('stopped');
    c.m.sendMessage('f', `replay-file ${caseFile('f2')}`);
    await until(() => readLog(c.log).some((x) => x.method === 'turn/interrupt' && x.params.threadId === 'sub-W'));
    expect(readLog(c.log).find((x) => x.method === 'turn/interrupt')?.params).toEqual({ threadId: 'sub-W', turnId: 'tw1' });
    expect(c.m.listSubagents('f')![0].state).toBe('stopped');
  });

  it('c: a stop of the thread interrupts its Codex sub-threads and lets them go', async () => {
    const c = codex();
    c.spawn('keep'); // keeps the shared app-server up after the stop
    c.spawn('k', 'thread-K');
    c.m.sendMessage('k', 'subagent slow');
    await until(() => c.m.listSubagents('k')?.[0]?.state === 'working');
    c.m.kill('k');
    await until(() => readLog(c.log).some((x) => x.method === 'thread/unsubscribe' && x.params.threadId === 'sub-thread-1'));
    expect(readLog(c.log).some((x) => x.method === 'turn/interrupt' && x.params.threadId === 'sub-thread-1')).toBe(true);
  });
});

describe('M2: a sub-thread belongs to one thread', () => {
  it("an item of thread B that names thread A's sub-thread changes nothing in B, and B reads nothing of it", async () => {
    const c = codex();
    c.spawn('A', 'thread-A');
    c.spawn('B', 'thread-B');
    c.m.sendMessage('A', `replay-file ${caseFile('a1')}`);
    await until(() => c.m.listSubagents('A')?.[0]?.state === 'working');
    c.m.sendMessage('B', `replay-file ${caseFile('b1')}`);
    await until(() => c.count('B', 'idle') === 1);
    expect(c.m.listSubagents('B')).toEqual([]);
    expect(await c.m.readSubagentHistory('B', 'sub-X')).toBeNull();
    expect(await c.m.stopSubagent('B', 'sub-X')).toBe('not-found');
  });

  it("the sub-thread of a stopped thread is never bound to another thread, and its result never reaches another main agent", async () => {
    const c = codex();
    c.spawn('C', 'thread-C');
    c.spawn('D', 'thread-D');
    c.m.sendMessage('C', `replay-file ${caseFile('c1')}`);
    await until(() => !!c.m.listSubagents('C')?.length);
    c.m.kill('C');
    c.m.sendMessage('D', `replay-file ${caseFile('d1')}`);
    await until(() => c.count('D', 'idle') === 1);
    await sleep(300);
    expect(c.m.listSubagents('D')).toEqual([]);
    expect((c.edges.D ?? []).some((x) => x.e === 'event' && x.arg?.parent_tool_use_id === 'sub-Y')).toBe(false);
    expect(c.turns('thread-D').join('\n')).not.toContain('THREAD C');
  });
});

describe('M3: an answer reaches only the request it names', () => {
  it('two requests at once: the waiting one cannot be answered with the input of the one in front; each answer carries its own input', async () => {
    const m = new ClaudeStructuredSessionManager();
    managers.push(m);
    const answers = tmpLog('answers');
    const shown: any[] = [];
    m.on('permission', (_t: string, p: any) => { shown.push(p); });
    m.spawn('q', { command: process.execPath, args: [twoRequests], workDir: process.cwd(), escalate: true, env: { ANSWER_LOG: answers, FRONT_CMD: 'rm -rf ./everything', QUEUED_CMD: 'ls' } });
    m.sendMessage('q', 'go');
    await until(() => !!m.getPending('q'));
    await sleep(200);
    const front = m.getPending('q')!;
    expect(front.requestId).toBe('req-FRONT');
    expect(m.hasWaitingPermission('q')).toBe(true);
    // The service builds updatedInput from the request in front; naming the waiting one must not send it.
    expect(m.answerPermission('q', 'req-QUEUED', { behavior: 'allow', updatedInput: { ...front.input } })).toBe(false);
    expect(m.answerPermission('q', 'req-FRONT', { behavior: 'deny', message: 'no' })).toBe(true);
    await until(() => m.getPending('q')?.requestId === 'req-QUEUED');
    const next = m.getPending('q')!;
    expect(shown.map((p) => p.requestId)).toEqual(['req-FRONT', 'req-QUEUED']);
    expect(m.answerPermission('q', 'req-QUEUED', { behavior: 'allow', updatedInput: { ...next.input } })).toBe(true);
    await until(() => readLog(answers).length === 2);
    expect(readLog(answers)).toEqual([
      { subtype: 'success', request_id: 'req-FRONT', response: { behavior: 'deny', message: 'no' } },
      { subtype: 'success', request_id: 'req-QUEUED', response: { behavior: 'allow', updatedInput: { command: 'ls' } } },
    ]);
  });
});

describe('M4: a blocked action of a subagent', () => {
  it("the card names the subagent, and Allow this goes to the sub-thread", async () => {
    const c = codex();
    c.spawn('r', 'thread-R');
    c.m.sendMessage('r', `replay-file ${caseFile('sub-review-denied')}`);
    await until(() => c.m.getBlocked('r').length === 1);
    expect(c.m.getBlocked('r')[0]).toMatchObject({ id: 'review-1', agentId: 'sub-R' });
    expect(await c.m.resolveBlocked('r', 'review-1', 'allow')).toBe(true);
    await until(() => readLog(c.log).some((x) => x.method === 'thread/approveGuardianDeniedAction'));
    expect(readLog(c.log).find((x) => x.method === 'thread/approveGuardianDeniedAction').params.threadId).toBe('sub-R');
  });
});

describe('M5: a session that ends ends its subagents', () => {
  it('Claude: a kill writes the stopped frame of a running background agent', async () => {
    const m = new ClaudeStructuredSessionManager();
    managers.push(m);
    const frames: any[] = [];
    m.on('event', (_t: string, e: any) => { if (e?.subtype === 'subagent') frames.push(e); });
    m.spawn('m5', { command: process.execPath, args: [replay], workDir: process.cwd(), env: { FAKE_CLAUDE_REPLAY: claudeFixture('stop-background') } });
    m.sendMessage('m5', 'go');
    await until(() => m.listSubagents('m5')?.[0]?.state === 'working');
    m.kill('m5');
    expect(frames.at(-1)).toMatchObject({ state: 'stopped', error: 'The session ended.' });
  });
});

describe('M6: the delivery turn', () => {
  it('a: a result that came during the main turn is delivered with no idle between the turn end and the delivery', async () => {
    const c = codex();
    c.spawn('d6', 'thread-D6');
    c.m.sendMessage('d6', `replay-file ${caseFile('during-turn')}`);
    await until(() => c.turns('thread-D6').length === 2 && c.count('d6', 'idle') === 1);
    expect(c.turns('thread-D6')[1]).toContain('quick check result');
    expect(c.nonEvent('d6')).toEqual(['busy', 'busy', 'busy', 'busy', 'idle']);
  });

  it('b: no delivery after a main turn that ended on a question', async () => {
    const c = codex();
    c.spawn('q6', 'thread-Q6');
    c.m.sendMessage('q6', `replay-file ${caseFile('during-turn-question')}`);
    await until(() => c.count('q6', 'needs-help') === 1);
    await sleep(300);
    expect(c.turns('thread-Q6')).toHaveLength(1);
  });

  it('c: an end reported before the sub-thread finished its turn waits for the final text (never "(no text)")', async () => {
    const c = codex();
    c.spawn('e6', 'thread-E6');
    c.m.sendMessage('e6', `replay-file ${caseFile('completed-early')}`);
    await until(() => c.turns('thread-E6').length === 2);
    expect(c.turns('thread-E6')[1]).toContain('the final words of the subagent');
    expect(c.turns('thread-E6')[1]).not.toContain('(no text)');
    expect(c.turns('thread-E6')[1]).toContain('NOT a message from the person');
  });
});
