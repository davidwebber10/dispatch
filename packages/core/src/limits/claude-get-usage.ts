// packages/core/src/limits/claude-get-usage.ts
// Claude's usage figures on a hosted box, without a token and without a model turn (2026-11-11).
//
// A hosted box never reads Claude's credential (auth/claude-cli-login.ts), so the token-based reader
// (claude-usage.ts) is off there, and the tiny-turn probe (claude-probe.ts) costs a model call. Claude
// Code answers a control request on a `--input-format stream-json` session with no turn at all:
//   → {"type":"control_request","request_id":"u1","request":{"subtype":"get_usage","skip_behaviors":true}}
//   ← {"type":"control_response","response":{"subtype":"success","request_id":"u1","response":{
//        "subscription_type":"max","rate_limits":{"five_hour":{"utilization":13,"resets_at":…},"seven_day":{…}},"limits":[…]}}}
// `utilization` is 0-100 here (the stream's rate_limit_event uses 0-1). The schema marks this
// request Experimental: anything we do not recognise gives no figures, never an error.
// The other source on a hosted box is the `rate_limit_event` every structured turn already emits
// (wire-limits.ts), so this child runs only when the figures are stale.
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import os from 'node:os';
import type { LimitSnapshots, LimitWindows } from './snapshot.js';

export type GetUsageSpawn = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }) => ChildProcessWithoutNullStreams;

export const GET_USAGE_ARGS = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--strict-mcp-config', '--setting-sources', '', '--tools', '', '--no-session-persistence',
];

const resetMs = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
};

/** The windows of a get_usage answer (`rate_limits`, utilization 0-100). Unknown shapes give {}. */
export function windowsFromGetUsage(resp: any): LimitWindows {
  const out: LimitWindows = {};
  const rl = resp?.rate_limits;
  if (!rl || typeof rl !== 'object') return out;
  for (const [type, w] of Object.entries(rl)) {
    const u = (w as any)?.utilization;
    const usedPercent = typeof u === 'number' && Number.isFinite(u) ? Math.min(100, Math.max(0, u)) : null;
    const resetsAt = resetMs((w as any)?.resets_at ?? (w as any)?.resetsAt);
    if (usedPercent !== null || resetsAt !== null) out[type] = { usedPercent, resetsAt };
  }
  return out;
}

export interface GetUsageDeps {
  snapshots: LimitSnapshots;
  accountFor: (provider: string, accountId?: string) => string;
  env: (accountId?: string) => Record<string, string>;
  spawn?: GetUsageSpawn;
  bin?: string;
  timeoutMs?: number;
  now?: () => number;
}

/** Ask one short-lived `claude -p --input-format stream-json` for get_usage. True when figures were recorded. */
export function createClaudeGetUsageProbe(d: GetUsageDeps): (accountId?: string) => Promise<boolean> {
  const spawnFn: GetUsageSpawn = d.spawn ?? ((cmd, args, o) => nodeSpawn(cmd, args, { env: o.env, cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams);
  return (accountId = 'cli') => new Promise<boolean>((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    // Never a token: the CLI's own login in its own config dir (the account's env carries CLAUDE_CONFIG_DIR).
    const env = { ...process.env, ...d.env(accountId), CLAUDE_CODE_OAUTH_TOKEN: '' } as NodeJS.ProcessEnv;
    try { child = spawnFn(d.bin ?? 'claude', GET_USAGE_ARGS, { env, cwd: os.tmpdir() }); } catch { resolve(false); return; }
    let buf = '';
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* closed */ }
      setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, 2000).unref?.();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), d.timeoutMs ?? 20_000);
    timer.unref?.();
    child.on('error', () => finish(false));
    child.on('exit', () => finish(false));
    child.stderr.on('data', () => { /* drained, never logged: it can name the account */ });
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.includes('control_response')) continue;
        try {
          const ev = JSON.parse(line);
          const r = ev?.response;
          if (ev?.type !== 'control_response' || r?.request_id !== 'dispatch-usage') continue;
          if (r.subtype !== 'success') return finish(false);
          const windows = windowsFromGetUsage(r.response);
          if (!Object.keys(windows).length) return finish(false);
          d.snapshots.record('claude-code', d.accountFor('claude-code', accountId), windows, (d.now ?? Date.now)(), undefined, false, undefined, accountId);
          return finish(true);
        } catch { /* a partial or foreign line */ }
      }
    });
    try {
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'dispatch-usage', request: { subtype: 'get_usage', skip_behaviors: true } }) + '\n');
    } catch { finish(false); }
  });
}
