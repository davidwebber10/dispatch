// packages/core/src/structured/codex-manager.policy.test.ts
//
// Task 5: the Codex manager must actually CONSULT `toolPolicy` in `handleApproval`, same
// semantics as the Claude manager's can_use_tool deny path (see manager.ts) — a deny answers
// the approval in-turn, on the same request, and NEVER creates a pending / involves the human.
// Reuses the fake `codex app-server` test harness from tests/structured/codex-manager.test.ts
// (extended with `exec <cmd>` / `ask ...` triggers for commandExecution + requestUserInput
// approvals) so these tests drive the manager through its real public surface, not internals.
import { it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexStructuredSessionManager } from './codex-manager.js';

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

let m: CodexStructuredSessionManager;
beforeEach(() => { m = new CodexStructuredSessionManager(); });
afterEach(() => { m.killAll(); });

it('a toolPolicy denying "git push" declines a commandExecution approval, in-turn, with no pending/permission emit', async () => {
  spawnFake(m, 't1', { toolPolicy: denyGitPush }); // escalate defaults false
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
