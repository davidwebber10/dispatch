// packages/core/tests/structured/codex-persona.contract.test.ts
//
// LIVE contract test: proves the Codex persona channel actually reaches the model, so a future
// refactor of codex-manager.ts can never silently regress it. The OpenAI-documented spelling
// (`settings.developer_instructions` on `thread/start`, per
// https://learn.chatgpt.com/docs/app-server.md) is silently IGNORED by codex-cli — the working
// channel is the TOP-LEVEL, camelCase `developerInstructions` param. This was discovered by a
// manual probe (kept at /tmp/codex-probe/probe.mjs) and is now load-bearing in
// codex-manager.ts's startThread. A unit test against a fake app-server (see
// codex-manager.systemprompt.test.ts) can only prove we SEND the right shape; it cannot prove
// the real binary honours it. This test spawns a REAL `codex app-server` child and asks the
// actual model to prove it.
//
// Protocol mirrors codex-manager.ts:250-269 (and the reference probe): `initialize` ->
// `initialized` notification -> `thread/start` -> `turn/start` -> wait for a turn-ending
// notification -> inspect the collected item/turn notifications for the canary text.
//
// OPT-IN: it runs REAL, billed model turns, so a plain `pnpm test` skips it. Run it with
// `DISPATCH_LIVE_CODEX=1` (and Codex installed AND signed in — see packages/core/src/setup/detect.ts).
// Also tolerates a live auth failure (e.g. an expired token the cheap sign-in probe didn't catch) or
// a turn that never completes by skipping rather than failing hard — this test's job is to catch a
// protocol regression, not to enforce that the machine running it is logged in.
//
// Only the AGENT'S REPLY text counts as evidence (item/completed agentMessage + agentMessage
// deltas) — never reasoning, which can quote the instruction without following it (review T2).
import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import os from 'node:os';
import { detectProvider } from '../../src/setup/detect.js';

const CANARY = 'Begin every single reply with the exact word MELON in capitals, then a space.';
const TURN_TIMEOUT_MS = 80_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 90_000;

const liveOptIn = process.env.DISPATCH_LIVE_CODEX === '1';
const codexStatus = liveOptIn
  ? await detectProvider('codex').catch(() => ({ installed: false, signedIn: false as const }))
  : { installed: false, signedIn: false as const };
const skipReason = !liveOptIn
  ? 'set DISPATCH_LIVE_CODEX=1 to run (real, billed model turns)'
  : !codexStatus.installed
    ? 'codex CLI not installed'
    : codexStatus.signedIn !== true
      ? 'codex CLI not signed in'
      : '';

// Failures that mean "this machine/run can't exercise the channel right now", not "the
// persona channel regressed" — these are soft-skipped instead of failing the suite:
//   - AUTH_FAILURE_RE:  an expired/missing login the cheap sign-in probe didn't catch.
//   - SPAWN_FAILURE_RE: `codex` binary missing or unspawnable (ENOENT/EACCES).
//   - TURN_NOT_DONE_RE: the model turn ended via turn/failed or turn/ended instead of
//     turn/completed (rate limit, network blip, refusal) — a live-infra hiccup, not a protocol
//     regression. A genuine turn/completed missing the canary still fails loudly below.
const AUTH_FAILURE_RE = /auth|sign.?in|log.?in|unauthorized|401|forbidden|credential/i;
const SPAWN_FAILURE_RE = /enoent|eacces|spawn\s+codex/i;
const TURN_NOT_DONE_RE = /^turn did not complete/i;

function isSoftSkipFailure(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return AUTH_FAILURE_RE.test(msg) || SPAWN_FAILURE_RE.test(msg) || TURN_NOT_DONE_RE.test(msg);
}

/** Races `promise` against a timeout, rejecting with `label` if the timeout wins. Mirrors the
 *  turnDone timeout pattern below, but rejects (rather than resolving a sentinel) since a
 *  hung handshake is not a valid protocol state to hand back to the caller. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * A minimal JSON-RPC 2.0 client over a real `codex app-server` child, just enough to run one
 * `initialize` -> `thread/start` -> `turn/start` -> wait-for-completion round trip. Deliberately
 * NOT reused from codex-manager.ts's CodexConnection: this test exists to catch a REAL protocol
 * regression, and importing the production connection class would let a bug in both places
 * cancel out silently.
 */
function withCodexAppServer<T>(run: (rpc: {
  request: (method: string, params: unknown) => Promise<any>;
  notify: (method: string, params?: unknown) => void;
  onNotification: (fn: (method: string, params: any) => void) => void;
}) => Promise<T>): Promise<T> {
  const child: ChildProcessWithoutNullStreams = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', () => { /* swallow: keep failures readable, not noisy */ });
  // Without this handler, a spawn failure (e.g. ENOENT if `codex` isn't on PATH) emits an
  // unhandled 'error' event, which Node treats as fatal and crashes the vitest worker instead
  // of letting the test soft-skip. Route it into the same promise `run(rpc)` races against.
  const spawnError = new Promise<never>((_resolve, reject) => {
    child.on('error', (err) => reject(err));
  });
  const rl = readline.createInterface({ input: child.stdout });
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  const notifHandlers: Array<(method: string, params: any) => void> = [];

  rl.on('line', (line) => {
    let frame: any;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.id !== undefined && frame.method === undefined) {
      const p = pending.get(frame.id);
      if (!p) return;
      pending.delete(frame.id);
      if (frame.error) p.reject(new Error(`${JSON.stringify(frame.error)}`));
      else p.resolve(frame.result);
      return;
    }
    if (frame.id !== undefined && typeof frame.method === 'string') {
      // server->client request: refuse politely so nothing hangs waiting on us.
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'unhandled' } }) + '\n');
      return;
    }
    if (typeof frame.method === 'string') {
      for (const h of notifHandlers) h(frame.method, frame.params ?? {});
    }
  });

  const rpc = {
    request(method: string, params: unknown): Promise<any> {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method: string, params?: unknown): void {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? null }) + '\n');
    },
    onNotification(fn: (method: string, params: any) => void): void {
      notifHandlers.push(fn);
    },
  };

  return Promise.race([run(rpc), spawnError]).finally(() => {
    try { rl.close(); } catch { /* noop */ }
    try { child.kill(); } catch { /* already gone */ }
  });
}

type Rpc = Parameters<Parameters<typeof withCodexAppServer>[0]>[0];

async function handshake(rpc: Rpc): Promise<void> {
  await withTimeout(
    rpc.request('initialize', {
      clientInfo: { name: 'dispatch-contract-test', title: 'Dispatch contract test', version: '0.0.1' },
    }),
    HANDSHAKE_TIMEOUT_MS,
    'initialize',
  );
  rpc.notify('initialized');
}

/**
 * Runs ONE turn on `threadId` and resolves with the AGENT'S REPLY text only: the completed
 * agentMessage item text (falling back to the streamed deltas). Reasoning never counts — a model
 * can quote the canary instruction while thinking and still not follow it (review T2). Rejects
 * into the soft-skip path unless a genuine turn/completed arrives: a failed/ended turn or a
 * timeout is a live-infra hiccup, and must never let a negative assertion pass vacuously.
 */
async function runTurn(rpc: Rpc, threadId: string, text: string): Promise<string> {
  const completed: string[] = [];
  const deltas: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const turnDone = new Promise<void>((resolve, reject) => {
    rpc.onNotification((method, params) => {
      if (params?.threadId !== undefined && params.threadId !== threadId) return;
      if (method === 'item/agentMessage/delta' && typeof params?.delta === 'string') deltas.push(params.delta);
      if (method === 'item/completed' && params?.item?.type === 'agentMessage' && typeof params.item.text === 'string') completed.push(params.item.text);
      if (/turn\/completed|turnCompleted/.test(method)) { resolve(); return; }
      if (/turn\/(failed|ended)|turnFailed/.test(method)) reject(new Error(`turn did not complete: received ${method} instead of turn/completed`));
    });
    timer = setTimeout(() => reject(new Error(`turn did not complete: timed out after ${TURN_TIMEOUT_MS}ms`)), TURN_TIMEOUT_MS);
  });
  try {
    await rpc.request('turn/start', { threadId, input: [{ type: 'text', text }] });
    await turnDone;
  } finally {
    clearTimeout(timer);
  }
  return completed.length ? completed.join('\n') : deltas.join('');
}

async function startThread(rpc: Rpc, extra: Record<string, unknown>): Promise<string> {
  const model = process.env.CODEX_TEST_MODEL;
  const started = await withTimeout(
    rpc.request('thread/start', { cwd: os.tmpdir(), approvalPolicy: 'never', sandbox: 'read-only', ...(model ? { model } : {}), ...extra }),
    HANDSHAKE_TIMEOUT_MS,
    'thread/start',
  );
  const threadId = started?.thread?.id;
  if (typeof threadId !== 'string' || !threadId) throw new Error('thread/start returned no threadId');
  return threadId;
}

/** thread/start with `extra` → one turn → the agent's reply text. */
function runCanaryTurn(threadStartExtra: Record<string, unknown>): Promise<string> {
  return withCodexAppServer(async (rpc) => {
    await handshake(rpc);
    const threadId = await startThread(rpc, threadStartExtra);
    return runTurn(rpc, threadId, 'Say hello in one short sentence.');
  });
}

/**
 * The RESUME half (review T2): start a thread with `startExtra` and finish a turn (so a rollout
 * exists), close that app-server, then `thread/resume` it from a FRESH app-server with
 * `resumeExtra` — the crash-recovery / daemon-restart path codex-manager.ts takes — and return the
 * reply to the next turn.
 */
async function runResumeCanaryTurn(startExtra: Record<string, unknown>, resumeExtra: Record<string, unknown>): Promise<string> {
  const threadId = await withCodexAppServer(async (rpc) => {
    await handshake(rpc);
    const id = await startThread(rpc, startExtra);
    await runTurn(rpc, id, 'Reply with the single word ok.');
    return id;
  });
  return withCodexAppServer(async (rpc) => {
    await handshake(rpc);
    const model = process.env.CODEX_TEST_MODEL;
    await withTimeout(
      rpc.request('thread/resume', { threadId, approvalPolicy: 'never', sandbox: 'read-only', ...(model ? { model } : {}), ...resumeExtra }),
      HANDSHAKE_TIMEOUT_MS,
      'thread/resume',
    );
    return runTurn(rpc, threadId, 'Say hello in one short sentence.');
  });
}

describe.skipIf(skipReason !== '')(`Codex persona injection (live contract)${skipReason ? ` [skipped: ${skipReason}]` : ''}`, () => {
  it(
    'reaches the model via top-level developerInstructions on thread/start',
    async () => {
      let reply: string;
      try {
        reply = await runCanaryTurn({ developerInstructions: CANARY });
      } catch (err) {
        if (isSoftSkipFailure(err)) return; // skip: live auth/spawn/turn-failure hiccup
        throw err;
      }
      expect(reply).toMatch(/MELON/);
    },
    TEST_TIMEOUT_MS,
  );

  // What Dispatch actually relies on for a revived coordinator: the persona given at thread/start
  // lives in the thread's own history, so a resume from a FRESH app-server keeps it.
  it(
    'a persona given at thread/start survives a thread/resume from a fresh app-server',
    async () => {
      let reply: string;
      try {
        reply = await runResumeCanaryTurn({ developerInstructions: CANARY }, {});
      } catch (err) {
        if (isSoftSkipFailure(err)) return; // skip: live auth/spawn/turn-failure hiccup
        throw err;
      }
      expect(reply).toMatch(/MELON/);
    },
    TEST_TIMEOUT_MS * 2,
  );

  // Documents a LIMIT (verified live on codex-cli 0.156.1, review T2): developerInstructions on
  // thread/resume is accepted but does NOT reach an existing thread — a persona CHANGE never
  // applies to a resumed thread; only a fresh thread/start carries a new persona. If this starts
  // failing, Codex began honoring it: revisit codex-manager.ts's resume comment.
  it(
    'developerInstructions on thread/resume does NOT change an existing thread\'s persona (documents the limit)',
    async () => {
      let reply: string;
      try {
        reply = await runResumeCanaryTurn({}, { developerInstructions: CANARY });
      } catch (err) {
        if (isSoftSkipFailure(err)) return; // skip: live auth/spawn/turn-failure hiccup
        throw err;
      }
      expect(reply.trim().length).toBeGreaterThan(0);
      expect(reply).not.toMatch(/MELON/);
    },
    TEST_TIMEOUT_MS * 2,
  );

  // Documents WHY we use the camelCase key: the OpenAI-documented `settings.developer_instructions`
  // spelling is accepted by thread/start (no error) but silently dropped — the model never sees
  // it. This is the negative half of the guard. It asserts only on a GENUINE completed turn with a
  // non-empty reply, so a timeout can never pass it vacuously.
  it(
    'does NOT reach the model via settings.developer_instructions (documents the silent drop)',
    async () => {
      let reply: string;
      try {
        reply = await runCanaryTurn({ settings: { developer_instructions: CANARY } });
      } catch (err) {
        if (isSoftSkipFailure(err)) return; // skip: live auth/spawn/turn-failure hiccup
        throw err;
      }
      expect(reply.trim().length).toBeGreaterThan(0);
      expect(reply).not.toMatch(/MELON/);
    },
    TEST_TIMEOUT_MS,
  );
});
