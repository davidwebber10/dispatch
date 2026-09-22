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
// Gated on Codex being installed AND signed in (see packages/core/src/setup/detect.ts). Also
// tolerates a live auth failure (e.g. an expired token the cheap sign-in probe didn't catch) by
// skipping rather than failing hard — this test's job is to catch a protocol regression, not to
// enforce that the machine running it is logged in.
import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import os from 'node:os';
import { detectProvider } from '../../src/setup/detect.js';

const CANARY = 'Begin every single reply with the exact word MELON in capitals, then a space.';
const TURN_TIMEOUT_MS = 80_000;
const TEST_TIMEOUT_MS = 90_000;

const codexStatus = await detectProvider('codex').catch(() => ({ installed: false, signedIn: false as const }));
const skipReason = !codexStatus.installed
  ? 'codex CLI not installed'
  : codexStatus.signedIn !== true
    ? 'codex CLI not signed in'
    : '';

const AUTH_FAILURE_RE = /auth|sign.?in|log.?in|unauthorized|401|forbidden|credential/i;

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

  return run(rpc).finally(() => {
    try { rl.close(); } catch { /* noop */ }
    try { child.kill(); } catch { /* already gone */ }
  });
}

/** Runs one full thread/start -> turn/start -> completion round trip, returning the blob of
 *  collected item/turn notification text the canary should show up in. */
async function runCanaryTurn(threadStartExtra: Record<string, unknown>): Promise<string> {
  return withCodexAppServer(async (rpc) => {
    const texts: string[] = [];
    rpc.onNotification((method, params) => {
      if (/item|turn/.test(method)) texts.push(`${method} ${JSON.stringify(params).slice(0, 2000)}`);
    });

    await rpc.request('initialize', {
      clientInfo: { name: 'dispatch-contract-test', title: 'Dispatch contract test', version: '0.0.1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    rpc.notify('initialized');

    const model = process.env.CODEX_TEST_MODEL;
    const started = await rpc.request('thread/start', {
      cwd: os.tmpdir(),
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ...(model ? { model } : {}),
      ...threadStartExtra,
    });
    const threadId = started?.thread?.id;
    if (typeof threadId !== 'string' || !threadId) throw new Error('thread/start returned no threadId');

    const turnDone = new Promise<string>((resolve) => {
      rpc.onNotification((method) => {
        if (/turn\/(completed|failed|ended)|turn(Completed|Failed)/.test(method)) resolve(method);
      });
      setTimeout(() => resolve('wait-timeout'), TURN_TIMEOUT_MS);
    });
    const turn = await rpc.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Say hello in one short sentence.' }],
    });
    await turnDone;

    return `${texts.join('\n')}\n${JSON.stringify(turn ?? {})}`;
  });
}

describe.skipIf(skipReason !== '')(`Codex persona injection (live contract)${skipReason ? ` [skipped: ${skipReason}]` : ''}`, () => {
  it(
    'reaches the model via top-level developerInstructions on thread/start',
    async () => {
      let blob: string;
      try {
        blob = await runCanaryTurn({ developerInstructions: CANARY });
      } catch (err) {
        if (AUTH_FAILURE_RE.test(String((err as Error)?.message ?? err))) return; // skip: live auth failure
        throw err;
      }
      expect(blob).toMatch(/MELON/);
    },
    TEST_TIMEOUT_MS,
  );

  // Documents WHY we use the camelCase key: the OpenAI-documented `settings.developer_instructions`
  // spelling is accepted by thread/start (no error) but silently dropped — the model never sees
  // it. This is the negative half of the guard; per the brief it's allowed to be skipped if
  // flaky/slow, but it must not be a hard gate on CI health.
  it(
    'does NOT reach the model via settings.developer_instructions (documents the silent drop)',
    async () => {
      let blob: string;
      try {
        blob = await runCanaryTurn({ settings: { developer_instructions: CANARY } });
      } catch (err) {
        if (AUTH_FAILURE_RE.test(String((err as Error)?.message ?? err))) return; // skip: live auth failure
        throw err;
      }
      expect(blob).not.toMatch(/MELON/);
    },
    TEST_TIMEOUT_MS,
  );
});
