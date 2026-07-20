// packages/core/tests/structured/codex-manager.test.ts
// Reuses the Claude structured-manager test patterns (a fake process, wait-for-event helpers)
// against a fake `codex app-server` speaking real JSON-RPC 2.0 frames — proving the manager
// spawns, streams Claude-shaped events, captures the ThreadId, and drives the approval membrane.
import { it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexStructuredSessionManager } from '../../src/structured/codex-manager.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-codex-app-server.mjs');
const spawnFake = (m: CodexStructuredSessionManager, id: string, opts: any = {}) =>
  m.spawn(id, { command: process.execPath, args: [fake], workDir: process.cwd(), ...opts });

function waitForEvent(m: CodexStructuredSessionManager, id: string, pred: (e: any) => boolean, timeoutMs = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    const buffered = m.getEvents(id).find(pred);
    if (buffered) { resolve(buffered); return; }
    const t = setTimeout(() => { m.off('event', on); reject(new Error('timeout')); }, timeoutMs);
    const on = (eid: string, e: any) => { if (eid === id && pred(e)) { clearTimeout(t); m.off('event', on); resolve(e); } };
    m.on('event', on);
  });
}

function waitForManagerEvent(m: CodexStructuredSessionManager, event: string, id: string, timeoutMs = 5000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { m.off(event, on); reject(new Error(`timeout waiting for '${event}'`)); }, timeoutMs);
    const on = (eid: string, ...rest: any[]) => { if (eid === id) { clearTimeout(t); m.off(event, on); resolve(rest); } };
    m.on(event, on);
  });
}

let m: CodexStructuredSessionManager;
beforeEach(() => { m = new CodexStructuredSessionManager(); });
afterEach(() => { m.killAll(); });

it('captures the ThreadId as the session id and emits a system/init with the model', async () => {
  const session = waitForManagerEvent(m, 'session', 't1');
  spawnFake(m, 't1');
  const [sessionId] = await session;
  expect(sessionId).toBe('thread-fake-1');
  expect(m.getSessionId('t1')).toBe('thread-fake-1');
  const init = await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  expect(init.model).toBe('gpt-5.6-sol');
});

it('streams a turn: synthetic user echo + assistant deltas + a result footer, and settles idle', async () => {
  spawnFake(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  const idle = waitForManagerEvent(m, 'idle', 't1');
  m.sendMessage('t1', 'stream please');
  await idle;
  const events = m.getEvents('t1');
  // Synthetic user echo (reproduces the Claude manager's behavior).
  expect(events.some((e: any) => e.type === 'user' && e.message?.content?.[0]?.text === 'stream please')).toBe(true);
  // Assistant text arrived as Anthropic stream_event deltas.
  const deltas = events.filter((e: any) => e.type === 'stream_event' && e.event?.type === 'content_block_delta').map((e: any) => e.event.delta.text);
  expect(deltas.join('')).toBe('Hello world');
  expect(events.some((e: any) => e.type === 'stream_event' && e.event?.type === 'message_start')).toBe(true);
  // Turn boundary → a result footer.
  expect(events.some((e: any) => e.type === 'result' && e.subtype === 'codex_turn')).toBe(true);
});

it('an escalating thread surfaces a file-change approval as pending; allow completes the turn', async () => {
  spawnFake(m, 't1', { escalate: true });
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  const permission = waitForManagerEvent(m, 'permission', 't1');
  m.sendMessage('t1', 'please approve the write');
  const [pending] = await permission;
  expect(pending.toolName).toBe('ApplyPatch');
  expect(pending.input.file_path).toBe('/tmp/hello.txt'); // recovered from the cached item/started
  expect(m.getPending('t1')).not.toBeNull();

  // Answering allow sends the Codex accept envelope; the fake then completes the turn.
  const idle = waitForManagerEvent(m, 'idle', 't1');
  const resolved = waitForManagerEvent(m, 'resolved', 't1');
  const ok = m.answerPermission('t1', pending.requestId, { behavior: 'allow' });
  expect(ok).toBe(true);
  await resolved;
  await idle;
  expect(m.getPending('t1')).toBeNull();
  // The completed file-change surfaced as a tool_result.
  expect(m.getEvents('t1').some((e: any) => e.type === 'user' && e.message?.content?.[0]?.type === 'tool_result')).toBe(true);
});

it('an autonomous (non-escalating) thread AUTO-APPROVES the file-change without surfacing it', async () => {
  spawnFake(m, 't1'); // escalate defaults to false
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  let surfaced = false;
  m.on('permission', (eid: string) => { if (eid === 't1') surfaced = true; });
  const idle = waitForManagerEvent(m, 'idle', 't1');
  m.sendMessage('t1', 'approve this write autonomously');
  await idle; // the fake only completes the turn AFTER receiving the auto-approval response
  expect(surfaced).toBe(false);
  expect(m.getPending('t1')).toBeNull();
});

it('resume backfills prior history from thread/read before going live', async () => {
  spawnFake(m, 't1', { resumeId: 'thread-existing-9' });
  await waitForEvent(m, 't1', (e) => e.type === 'assistant' && e.message?.content?.[0]?.text === 'earlier answer');
  const events = m.getEvents('t1');
  expect(events.some((e: any) => e.type === 'user' && e.message?.content === 'earlier question')).toBe(true);
});

// --- Task 7: turn-end status truth for Codex + the Task 5 review addition (a Codex idle turn
// must persist its OWN completed agentMessage text as the outcome summary, never the generic
// Claude-ring walk — which on Codex returns either nothing or STALE text backfilled from a
// prior resume, since a live Codex turn never produces a whole `assistant` text event).

it('idle carries the turn\'s own completed agentMessage text as `summary`', async () => {
  spawnFake(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  const idle = waitForManagerEvent(m, 'idle', 't1');
  m.sendMessage('t1', 'stream please');
  const [detail] = await idle;
  expect(detail).toMatchObject({ declared: false, summary: 'Hello world' });
});

it('idle summary reflects the CURRENT turn, not stale text backfilled from a resumed session', async () => {
  spawnFake(m, 't1', { resumeId: 'thread-existing-9' });
  // Backfill lands first — the ring now holds a whole `assistant` text event ('earlier
  // answer') that the OLD Claude-ring-walk heuristic would latch onto forever, since a live
  // Codex turn never produces another event of that exact shape.
  await waitForEvent(m, 't1', (e) => e.type === 'assistant' && e.message?.content?.[0]?.text === 'earlier answer');
  const idle = waitForManagerEvent(m, 'idle', 't1');
  m.sendMessage('t1', 'stream please');
  const [detail] = await idle;
  expect(detail.summary).toBe('Hello world'); // this turn's own text
  expect(detail.summary).not.toContain('earlier answer'); // NOT the stale backfilled text
});

it('interrupt asks the server to end the turn (settles idle)', async () => {
  spawnFake(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  // Kick a turn so a currentTurnId exists to interrupt.
  const busy = waitForManagerEvent(m, 'busy', 't1');
  m.sendMessage('t1', 'stream');
  await busy;
  // Give the turn/started notification a tick to land so currentTurnId is set.
  await new Promise((r) => setTimeout(r, 50));
  const idle = waitForManagerEvent(m, 'idle', 't1');
  expect(m.interrupt('t1')).toBe(true);
  await idle;
});
