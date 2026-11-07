// packages/core/src/limits/claude-probe.ts
// Claude's limits without a Pretty thread (2026-11-05). Claude Code reports the account's usage
// windows (a `rate_limit_event`) on every turn of a structured session, which is how Pretty threads
// and Chat keep the gauge current. CLI threads never report them. So when the figures go stale,
// the daemon runs one tiny turn itself: `claude -p` on Haiku, no tools, MCP, settings or session,
// a two-word prompt; it answers in about 2 s and costs a handful of tokens. Signed in the way a
// thread is (the thread spawn env carries Dispatch's saved Claude token).
import os from 'os';
import path from 'path';
import fs from 'fs';
import { resolveBin, detectProvider } from '../setup/detect.js';
import { runCommand, type CommandRunner } from '../sessions/cli-namer.js';
import { parseClaudeRateLimit, type LimitSnapshots } from './snapshot.js';

export const PROBE_MODEL = 'claude-haiku-5-5';
const TIMEOUT_MS = 30_000;

/** The windows of every `rate_limit_event` in a stream-json run, merged (later events win). */
export function windowsFromStream(stdout: string): ReturnType<typeof parseClaudeRateLimit> {
  let out: ReturnType<typeof parseClaudeRateLimit> = {};
  for (const line of stdout.split('\n')) {
    if (!line.includes('rate_limit_event')) continue;
    try {
      const ev = JSON.parse(line);
      if (ev?.type === 'rate_limit_event') out = { ...out, ...parseClaudeRateLimit(ev.rate_limit_info) };
    } catch { /* a partial line */ }
  }
  return out;
}

export interface ClaudeProbeDeps {
  snapshots: LimitSnapshots;
  accountFor: (provider: string, accountId?: string) => string;
  /** The env a thread of that account is spawned with, overlaid on the daemon's own. */
  env: (accountId?: string) => Record<string, string>;
  now?: () => number;
  /** Injectable for tests. */
  run?: CommandRunner;
  bin?: () => Promise<string | null>;
  signedIn?: () => Promise<boolean | 'unknown'>;
}

/** One probe: run the tiny turn and record the windows it reported. True when figures were recorded. */
// An added account (2026-11-07) signs in with its own `claude setup-token` token, which may run a model
// but not read the usage or profile endpoints: this turn is how its figures are read at all.
export function createClaudeProbe(d: ClaudeProbeDeps): (accountId?: string) => Promise<boolean> {
  const now = d.now ?? Date.now;
  return async (accountId = 'cli') => {
    const bin = await (d.bin ?? (() => resolveBin('claude')))();
    if (!bin) return false;
    // The CLI's own login only: an added account carries its token in the env.
    if (accountId === 'cli') {
      const signedIn = await (d.signedIn ?? (async () => (await detectProvider('claude')).signedIn))().catch(() => 'unknown' as const);
      if (signedIn === false) return false;
    }
    // An empty folder, so the CLI picks up no project's CLAUDE.md.
    const cwd = path.join(os.tmpdir(), 'dispatch-usage-probe');
    try { fs.mkdirSync(cwd, { recursive: true }); } catch { /* the spawn reports it */ }
    const args = [
      '-p', '--model', PROBE_MODEL, '--output-format', 'stream-json', '--verbose',
      '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands',
      '--no-session-persistence', '--effort', 'low', '--system-prompt', 'Reply with: ok',
    ];
    const r = await (d.run ?? runCommand)(bin, args, { stdin: 'ok', env: d.env(accountId), cwd, timeoutMs: TIMEOUT_MS });
    const windows = windowsFromStream(r.stdout);
    if (!Object.keys(windows).length) return false;
    d.snapshots.record('claude-code', d.accountFor('claude-code', accountId), windows, now(), undefined, false, undefined, accountId);
    return true;
  };
}
