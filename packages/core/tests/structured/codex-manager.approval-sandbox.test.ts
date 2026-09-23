// packages/core/tests/structured/codex-manager.approval-sandbox.test.ts
//
// Task 6: a Codex COORDINATOR thread must spawn with `approvalPolicy: 'on-request'` +
// `sandbox: 'read-only'` so the enforcement membrane (Task 5's handleApproval toolPolicy gate)
// actually fires — under `workspace-write` an in-workspace repo write/`git commit` runs WITHOUT
// ever surfacing an approval, so the membrane never sees exactly the actions it must block (see
// codex-manager.ts's CodexManagerOptions doc comment). A non-coordinator codex thread must keep
// today's manager-construction defaults (`on-request` / `workspace-write`).
//
// Live-verified against the real installed `codex app-server` (codex-cli 0.155.1, see
// /tmp/codex-probe2/probe.mjs): `thread/start` with `approvalPolicy: 'on-request'` +
// `sandbox: 'read-only'` is ACCEPTED, and a `git commit` inside that thread surfaced a real
// `item/commandExecution/requestApproval` ServerRequest (the membrane fires) before the
// read-only sandbox itself blocked the write. `codex app-server generate-ts` bindings
// (AskForApproval / SandboxMode) confirm 'untrusted' | 'on-request' | 'never' and
// 'read-only' | 'workspace-write' | 'danger-full-access' are the CLI's real wire literals — the
// existing type union in codex-manager.ts was already correct, nothing to rename.
//
// Reuses the fake-codex-app-server.mjs CODEX_FAKE_LOG harness (see
// codex-manager.systemprompt.test.ts) to inspect the exact `thread/start`/`thread/resume` params
// the manager sent, rather than relying on manager-internal state.
import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexStructuredSessionManager } from '../../src/structured/codex-manager.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-codex-app-server.mjs');

let m: CodexStructuredSessionManager;
let logPath: string;

beforeEach(() => {
  m = new CodexStructuredSessionManager();
  logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fake-log-')), 'requests.jsonl');
});
afterEach(() => { m.killAll(); });

function readLogged(method: string): any[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.method === method);
}

function waitForEvent(mgr: CodexStructuredSessionManager, id: string, pred: (e: any) => boolean, timeoutMs = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    const buffered = mgr.getEvents(id).find(pred);
    if (buffered) { resolve(buffered); return; }
    const t = setTimeout(() => { mgr.off('event', on); reject(new Error('timeout')); }, timeoutMs);
    const on = (eid: string, e: any) => { if (eid === id && pred(e)) { clearTimeout(t); mgr.off('event', on); resolve(e); } };
    mgr.on('event', on);
  });
}

it('a coordinator-role codex spawn (approvalPolicy/sandbox passed per-spawn) sends thread/start with the ask policy + read-only sandbox', async () => {
  m.spawn('t1', {
    command: process.execPath,
    args: [fake],
    workDir: process.cwd(),
    approvalPolicy: 'on-request',
    sandbox: 'read-only',
    env: { CODEX_FAKE_LOG: logPath },
  });
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');

  const [sent] = readLogged('thread/start');
  expect(sent).toBeDefined();
  expect(sent.params.approvalPolicy).toBe('on-request');
  expect(sent.params.sandbox).toBe('read-only');
});

it('a non-coordinator codex spawn (no override) keeps the manager\'s today-default approvalPolicy/sandbox', async () => {
  m.spawn('t1', {
    command: process.execPath,
    args: [fake],
    workDir: process.cwd(),
    env: { CODEX_FAKE_LOG: logPath },
  });
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');

  const [sent] = readLogged('thread/start');
  expect(sent).toBeDefined();
  expect(sent.params.approvalPolicy).toBe('on-request'); // manager default, unchanged by this task
  expect(sent.params.sandbox).toBe('workspace-write'); // manager default, unchanged by this task
});

it('carries the per-spawn approvalPolicy/sandbox override through a crash-recovery thread/resume too', async () => {
  m.spawn('t1', {
    command: process.execPath,
    args: [fake],
    workDir: process.cwd(),
    approvalPolicy: 'on-request',
    sandbox: 'read-only',
    resumeId: 'thread-existing-9',
    env: { CODEX_FAKE_LOG: logPath },
  });
  await waitForEvent(m, 't1', (e) => e.type === 'assistant' && e.message?.content?.[0]?.text === 'earlier answer');

  const [sent] = readLogged('thread/resume');
  expect(sent).toBeDefined();
  expect(sent.params.approvalPolicy).toBe('on-request');
  expect(sent.params.sandbox).toBe('read-only');
});

it('a manager constructed with different defaults still lets a per-spawn override win', async () => {
  const m2 = new CodexStructuredSessionManager({ approvalPolicy: 'never', sandbox: 'workspace-write' });
  try {
    m2.spawn('t1', {
      command: process.execPath,
      args: [fake],
      workDir: process.cwd(),
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      env: { CODEX_FAKE_LOG: logPath },
    });
    await waitForEvent(m2, 't1', (e) => e.type === 'system' && e.subtype === 'init');
    const [sent] = readLogged('thread/start');
    expect(sent.params.approvalPolicy).toBe('on-request');
    expect(sent.params.sandbox).toBe('read-only');
  } finally {
    m2.killAll();
  }
});

// N3 (independent review of PR #47): Codex can route approval requests to its OWN reviewer
// (`approvals_reviewer = "auto_review" | "guardian_subagent"` in config.toml). Then a sandbox
// escape is answered inside Codex and never reaches Dispatch as a ServerRequest, so the
// coordinator membrane (handleApproval → toolPolicy) never sees it. A governed thread (any
// toolPolicy) must therefore pin the reviewer to `user` — i.e. the client, Dispatch — on BOTH
// thread/start and thread/resume. Live-verified on codex-cli 0.156.1: thread/start accepts
// `approvalsReviewer: 'user'` and echoes it back; an unknown value is rejected.
const allowAll = () => ({ allow: true as const });

it('a governed thread (toolPolicy set) pins approvalsReviewer "user" on thread/start', async () => {
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), toolPolicy: allowAll, env: { CODEX_FAKE_LOG: logPath } });
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  const [sent] = readLogged('thread/start');
  expect(sent.params.approvalsReviewer).toBe('user');
});

it('a governed thread pins approvalsReviewer "user" on a thread/resume too', async () => {
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), toolPolicy: allowAll, resumeId: 'thread-existing-9', env: { CODEX_FAKE_LOG: logPath } });
  await waitForEvent(m, 't1', (e) => e.type === 'assistant' && e.message?.content?.[0]?.text === 'earlier answer');
  const [sent] = readLogged('thread/resume');
  expect(sent.params.approvalsReviewer).toBe('user');
});

it('an ungoverned thread (no toolPolicy) leaves the reviewer to the user\'s own Codex config', async () => {
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), env: { CODEX_FAKE_LOG: logPath } });
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  const [sent] = readLogged('thread/start');
  expect(sent.params).not.toHaveProperty('approvalsReviewer');
});

// M3 FIX: the shared app-server's argv/env belong to whichever thread spawned it first, so each
// thread's own MCP servers (the dispatch identity) ride ITS thread/start `config` — and its
// thread/resume `config` too, since crash recovery resumes every thread on a FRESH app-server.
// Live-verified on codex-cli 0.156.1: each thread then gets its own MCP server process with its
// own env; a thread config wins over an app-server `-c`; resume applies config.
const cfgFor = (id: string) => ({ 'mcp_servers.dispatch': { command: 'node', args: ['agency.js'], env: { DISPATCH_TERMINAL: id } } });

it('sends the spawn\'s per-thread config on thread/start', async () => {
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), threadConfig: cfgFor('t1'), env: { CODEX_FAKE_LOG: logPath } });
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  const [sent] = readLogged('thread/start');
  expect(sent.params.config).toEqual(cfgFor('t1'));
});

it('re-sends the per-thread config on thread/resume', async () => {
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), threadConfig: cfgFor('t1'), resumeId: 'thread-existing-9', env: { CODEX_FAKE_LOG: logPath } });
  await waitForEvent(m, 't1', (e) => e.type === 'assistant' && e.message?.content?.[0]?.text === 'earlier answer');
  const [sent] = readLogged('thread/resume');
  expect(sent.params.config).toEqual(cfgFor('t1'));
});

it('two threads on ONE shared app-server each send their OWN identity config', async () => {
  const pid1 = m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), threadConfig: cfgFor('t1'), env: { CODEX_FAKE_LOG: logPath } });
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  const pid2 = m.spawn('t2', { command: process.execPath, args: [fake], workDir: process.cwd(), threadConfig: cfgFor('t2') });
  expect(pid2).toBe(pid1); // one shared app-server …
  await new Promise((r) => setTimeout(r, 300));
  const starts = readLogged('thread/start').map((e) => e.params.config?.['mcp_servers.dispatch']?.env?.DISPATCH_TERMINAL);
  expect(starts).toEqual(['t1', 't2']); // … but each thread carries its own identity
});

it('omits config entirely when the spawn has none', async () => {
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), env: { CODEX_FAKE_LOG: logPath } });
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  const [sent] = readLogged('thread/start');
  expect(sent.params).not.toHaveProperty('config');
});
