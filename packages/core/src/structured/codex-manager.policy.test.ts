// packages/core/src/structured/codex-manager.policy.test.ts
//
// Task 5: the Codex manager must actually CONSULT `toolPolicy` in `handleApproval`, same
// semantics as the Claude manager's can_use_tool deny path (see manager.ts) — a deny answers
// the approval in-turn, on the same request, and NEVER creates a pending / involves the human.
// Reuses the fake `codex app-server` test harness from tests/structured/codex-manager.test.ts
// (extended with `exec <cmd>` / `ask ...` triggers for commandExecution + requestUserInput
// approvals) so these tests drive the manager through its real public surface, not internals.
import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexStructuredSessionManager } from './codex-manager.js';
import { makeCoordinatorPolicy, coordinatorMemoryDirFor } from '../overseer/coordinator-policy.js';

const fake = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'tests', 'structured', 'fake-codex-app-server.mjs',
);
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

/** Denies any Bash command containing "git push" (post-adaptForPolicy shape: Bash/{command}). */
const denyGitPush = (toolName: string, input: unknown) => {
  const command = (input as any)?.command;
  if (toolName === 'Bash' && typeof command === 'string' && command.includes('git push')) {
    return { allow: false as const, message: 'ground rule: no git push without a human' };
  }
  return { allow: true as const };
};

/** A fresh CODEX_FAKE_LOG file path per test, so the fake app-server's request/response log
 *  (see fake-codex-app-server.mjs's logRequest/logResponse) can be read back and asserted on —
 *  the only way to see the actual WIRE response the manager sent for an approval, as opposed to
 *  the manager's own in-process events (Fix 2: a deny→allow regression at the response would
 *  pass every other assertion in this file). */
function makeFakeLogPath(): string {
  return path.join(os.tmpdir(), `codex-fake-log-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ndjson`);
}
function readFakeLog(logPath: string): Array<{ method?: string; response?: string; result?: unknown }> {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
/** Poll for a log entry rather than reading once: the fake app-server is a SEPARATE process, so
 *  its `fs.appendFileSync` for a response only happens after it has read the manager's write off
 *  the pipe — strictly later than the manager's own in-process 'event' emit the test awaited
 *  above. Reading the file exactly once right after that in-process event is a real race (seen
 *  flaking under full-suite load), not a hypothetical one. */
async function waitForLogEntry(logPath: string, pred: (e: any) => boolean, timeoutMs = 5000): Promise<any> {
  const start = Date.now();
  for (;;) {
    const found = readFakeLog(logPath).find(pred);
    if (found) return found;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for a fake-log entry in ${logPath}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

let m: CodexStructuredSessionManager;
beforeEach(() => { m = new CodexStructuredSessionManager(); });
afterEach(() => { m.killAll(); });

it('a toolPolicy denying "git push" declines a commandExecution approval, in-turn, with no pending/permission emit', async () => {
  const logPath = makeFakeLogPath();
  spawnFake(m, 't1', { toolPolicy: denyGitPush, env: { CODEX_FAKE_LOG: logPath } }); // escalate defaults false
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  let surfaced = false;
  m.on('permission', (eid: string) => { if (eid === 't1') surfaced = true; });

  m.sendMessage('t1', 'exec git push');

  // The synthetic tool_result carrying the deny message lands in the ring (the coordinator's
  // only way to see WHY, since Codex's own decline envelope carries no message field).
  const denyResult = await waitForEvent(
    m, 't1',
    (e) => e.type === 'user' && e.message?.content?.[0]?.type === 'tool_result' && e.message.content[0].is_error === true,
  );
  expect(denyResult.message.content[0].content).toBe('ground rule: no git push without a human');
  expect(denyResult.message.content[0].tool_use_id).toBe('cmd-1');

  expect(surfaced).toBe(false); // never surfaced to a human
  expect(m.getPending('t1')).toBeNull(); // never created a pending

  // Fix 2: assert the actual WIRE response, not just the manager's in-process events — a
  // deny→allow regression at buildApprovalResponse would still pass every assertion above.
  const approvalResponse = await waitForLogEntry(logPath, (e) => e.response === 'item/commandExecution/requestApproval');
  expect(approvalResponse.result).toEqual({ decision: 'decline' });
});

it('a benign command under the same policy auto-approves (accept), no denial event', async () => {
  spawnFake(m, 't1', { toolPolicy: denyGitPush });
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  let surfaced = false;
  m.on('permission', (eid: string) => { if (eid === 't1') surfaced = true; });

  const idle = waitForManagerEvent(m, 'idle', 't1');
  m.sendMessage('t1', 'exec ls');
  await idle; // the fake only completes the turn after receiving the manager's response

  expect(surfaced).toBe(false);
  expect(m.getPending('t1')).toBeNull();
  const events = m.getEvents('t1');
  expect(events.some((e: any) => e.type === 'user' && e.message?.content?.[0]?.is_error === true)).toBe(false);
  expect(events.some((e: any) => e.type === 'user' && e.message?.content?.[0]?.type === 'tool_result' && e.message.content[0].tool_use_id === 'cmd-1')).toBe(true);
});

it('a policy deny wins over escalate=true — the thread never sees a pending for the denied command', async () => {
  spawnFake(m, 't1', { toolPolicy: denyGitPush, escalate: true });
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  let surfaced = false;
  m.on('permission', (eid: string) => { if (eid === 't1') surfaced = true; });

  m.sendMessage('t1', 'exec git push');
  await waitForEvent(m, 't1', (e) => e.type === 'user' && e.message?.content?.[0]?.is_error === true);

  expect(surfaced).toBe(false);
  expect(m.getPending('t1')).toBeNull();
});

it('an alwaysSurface requestUserInput is exempt from toolPolicy — it still surfaces even though the policy would deny everything', async () => {
  const denyEverything = () => ({ allow: false as const, message: 'nope' });
  spawnFake(m, 't1', { toolPolicy: denyEverything }); // escalate defaults false
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');

  const permission = waitForManagerEvent(m, 'permission', 't1');
  m.sendMessage('t1', 'ask the user something');
  const [pending] = await permission;

  expect(pending.toolName).toBe('AskUserQuestion');
  expect(m.getPending('t1')).not.toBeNull();
});

it('a governed thread (toolPolicy set) NEVER self-escalates its own sandbox permissions, even when the policy itself would allow everything', async () => {
  // The policy here is permissive (unknown 'Permissions' tool ⇒ allow) so this proves the
  // guard is a hardcoded categorical deny in handleApproval, not a side effect of the policy
  // function's own logic — a coordinator must never grant itself expanded access, full stop.
  const allowEverything = () => ({ allow: true as const });
  const logPath = makeFakeLogPath();
  spawnFake(m, 't1', { toolPolicy: allowEverything, env: { CODEX_FAKE_LOG: logPath } }); // escalate defaults false
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  let surfaced = false;
  m.on('permission', (eid: string) => { if (eid === 't1') surfaced = true; });

  m.sendMessage('t1', 'escalate my sandbox');

  const denyResult = await waitForEvent(
    m, 't1',
    (e) => e.type === 'user' && e.message?.content?.[0]?.type === 'tool_result' && e.message.content[0].is_error === true,
  );
  expect(denyResult.message.content[0].tool_use_id).toBe('perm-1');
  expect(denyResult.message.content[0].content).toMatch(/cannot change its own sandbox or approval permissions/i);

  expect(surfaced).toBe(false); // never surfaced to a human
  expect(m.getPending('t1')).toBeNull(); // never created a pending

  // The wire response is the empty-profile decline variant (buildApprovalResponse's
  // permissions-decline shape), NOT the permissions the model actually asked for
  // ({ network: true, sandbox: 'danger-full-access' } per the fake's `escalate` trigger).
  const approvalResponse = await waitForLogEntry(logPath, (e) => e.response === 'item/permissions/requestApproval');
  expect(approvalResponse.result).toEqual({ permissions: {}, scope: 'turn' });
});

it('a governed thread with escalate=true STILL never self-escalates permissions (escalate only affects human-in-the-loop surfacing, not this guard)', async () => {
  const allowEverything = () => ({ allow: true as const });
  spawnFake(m, 't1', { toolPolicy: allowEverything, escalate: true });
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  let surfaced = false;
  m.on('permission', (eid: string) => { if (eid === 't1') surfaced = true; });

  m.sendMessage('t1', 'escalate my sandbox');
  await waitForEvent(m, 't1', (e) => e.type === 'user' && e.message?.content?.[0]?.is_error === true);

  expect(surfaced).toBe(false);
  expect(m.getPending('t1')).toBeNull();
});

it('an UNgoverned thread (no toolPolicy) keeps auto-granting a permissions escalation exactly as today', async () => {
  spawnFake(m, 't1', {}); // no toolPolicy at all, escalate defaults false
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  let surfaced = false;
  m.on('permission', (eid: string) => { if (eid === 't1') surfaced = true; });

  const idle = waitForManagerEvent(m, 'idle', 't1');
  m.sendMessage('t1', 'escalate my sandbox');
  await idle;

  expect(surfaced).toBe(false);
  expect(m.getPending('t1')).toBeNull();
  const events = m.getEvents('t1');
  // No synthetic denial tool_result — an ungoverned thread's escalation is auto-approved, same
  // as before this fix.
  expect(events.some((e: any) => e.type === 'user' && e.message?.content?.[0]?.is_error === true)).toBe(false);
});

// --- Fix 3: fileChange (ApplyPatch) policy tests, using the REAL coordinator policy -----------

it('a two-file ApplyPatch touching one memory path and one repo path is DENIED (decline on the wire)', async () => {
  const memoryDir = path.join(os.tmpdir(), `coordinator-memory-${process.pid}-${Date.now()}`);
  const policy = makeCoordinatorPolicy(memoryDir);
  const logPath = makeFakeLogPath();
  spawnFake(m, 't1', { toolPolicy: policy, env: { CODEX_FAKE_LOG: logPath } });
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  let surfaced = false;
  m.on('permission', (eid: string) => { if (eid === 't1') surfaced = true; });

  const memoryPath = path.join(memoryDir, 'notes.md');
  const repoPath = path.join(process.cwd(), 'README.md');
  m.sendMessage('t1', `patch ${memoryPath},${repoPath}`);

  const denyResult = await waitForEvent(
    m, 't1',
    (e) => e.type === 'user' && e.message?.content?.[0]?.type === 'tool_result' && e.message.content[0].is_error === true,
  );
  expect(denyResult.message.content[0].tool_use_id).toBe('fc-2');
  expect(surfaced).toBe(false);
  expect(m.getPending('t1')).toBeNull();

  const approvalResponse = await waitForLogEntry(logPath, (e) => e.response === 'item/fileChange/requestApproval');
  expect(approvalResponse.result).toEqual({ decision: 'decline' });
});

it('an all-memory-path ApplyPatch is ALLOWED (accept on the wire)', async () => {
  const memoryDir = path.join(os.tmpdir(), `coordinator-memory-${process.pid}-${Date.now()}-b`);
  const policy = makeCoordinatorPolicy(memoryDir);
  const logPath = makeFakeLogPath();
  spawnFake(m, 't1', { toolPolicy: policy, env: { CODEX_FAKE_LOG: logPath } });
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  let surfaced = false;
  m.on('permission', (eid: string) => { if (eid === 't1') surfaced = true; });

  const pathA = path.join(memoryDir, 'a.md');
  const pathB = path.join(memoryDir, 'b.md');
  const idle = waitForManagerEvent(m, 'idle', 't1');
  m.sendMessage('t1', `patch ${pathA},${pathB}`);
  await idle;

  expect(surfaced).toBe(false);
  expect(m.getPending('t1')).toBeNull();
  const events = m.getEvents('t1');
  expect(events.some((e: any) => e.type === 'user' && e.message?.content?.[0]?.is_error === true)).toBe(false);

  const approvalResponse = await waitForLogEntry(logPath, (e) => e.response === 'item/fileChange/requestApproval');
  expect(approvalResponse.result).toEqual({ decision: 'accept' });
});

it('an ApplyPatch that MOVES a memory file onto a repo path is DENIED end-to-end (M2, decline on the wire)', async () => {
  const memoryDir = path.join(os.tmpdir(), `coordinator-memory-${process.pid}-${Date.now()}-move`);
  const policy = makeCoordinatorPolicy(memoryDir);
  const logPath = makeFakeLogPath();
  spawnFake(m, 't1', { toolPolicy: policy, env: { CODEX_FAKE_LOG: logPath } });
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  let surfaced = false;
  m.on('permission', (eid: string) => { if (eid === 't1') surfaced = true; });

  const src = path.join(memoryDir, 'a.md');            // source inside the memory dir
  const dest = path.join(process.cwd(), 'ESCAPED.ts'); // destination in the repo
  m.sendMessage('t1', `patchmove ${src}>${dest}`);

  const denyResult = await waitForEvent(
    m, 't1',
    (e) => e.type === 'user' && e.message?.content?.[0]?.type === 'tool_result' && e.message.content[0].is_error === true,
  );
  expect(denyResult.message.content[0].tool_use_id).toBe('fc-2');
  expect(surfaced).toBe(false);
  expect(m.getPending('t1')).toBeNull();

  const approvalResponse = await waitForLogEntry(logPath, (e) => e.response === 'item/fileChange/requestApproval');
  expect(approvalResponse.result).toEqual({ decision: 'decline' });
});
