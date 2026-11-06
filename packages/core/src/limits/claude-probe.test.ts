import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { LimitSnapshots } from './snapshot.js';
import { createClaudeProbe, windowsFromStream, PROBE_MODEL } from './claude-probe.js';
import type { CommandRunner } from '../sessions/cli-namer.js';

// The real stream from `claude -p --output-format stream-json` (2.1.318, 2026-11-05), trimmed.
const STREAM = [
  '{"type":"system","subtype":"init"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}',
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1794416400,"rateLimitType":"seven_day","unifiedWindows":{"seven_day":{"utilization":0.02,"resetsAt":1794416400,"status":"allowed"}}}}',
  '{"type":"result","subtype":"success"}',
].join('\n');

describe('Claude usage probe', () => {
  it('reads the windows from the turn\'s rate_limit_event', () => {
    expect(windowsFromStream(STREAM)).toEqual({ seven_day: { usedPercent: 2, resetsAt: 1794416400000 } });
  });

  it('runs one tiny Haiku turn with no tools, MCP, settings or session, and records what it reported', async () => {
    const db = new Database(':memory:'); initSchema(db);
    const snaps = new LimitSnapshots(db);
    const run = vi.fn<CommandRunner>().mockResolvedValue({ code: 0, stdout: STREAM });
    const probe = createClaudeProbe({ snapshots: snaps, accountFor: () => 'acct', env: () => ({}), now: () => 1793900000000, run, bin: async () => '/bin/claude', signedIn: async () => true });
    expect(await probe()).toBe(true);
    const args = run.mock.calls[0][1];
    expect(args[args.indexOf('--model') + 1]).toBe(PROBE_MODEL);
    for (const f of ['-p', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) expect(args).toContain(f);
    expect(snaps.get('claude-code', 'acct')!.windows.seven_day).toEqual({ usedPercent: 2, resetsAt: 1794416400000 });
  });

  it('does nothing when Claude is signed out or the turn reports no windows', async () => {
    const db = new Database(':memory:'); initSchema(db);
    const snaps = new LimitSnapshots(db);
    const run = vi.fn<CommandRunner>().mockResolvedValue({ code: 0, stdout: '{"type":"result"}' });
    expect(await createClaudeProbe({ snapshots: snaps, accountFor: () => 'acct', env: () => ({}), run, bin: async () => '/bin/claude', signedIn: async () => false })()).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(await createClaudeProbe({ snapshots: snaps, accountFor: () => 'acct', env: () => ({}), run, bin: async () => '/bin/claude', signedIn: async () => true })()).toBe(false);
    expect(snaps.get('claude-code', 'acct')).toBeNull();
  });
});
