import { describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createClaudeGetUsageProbe, windowsFromGetUsage, GET_USAGE_ARGS } from './claude-get-usage.js';

function fakeClaude(answer: (req: any) => string | null) {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const spawn = vi.fn((_c: string, args: string[], o: { env: NodeJS.ProcessEnv }) => {
    calls.push({ args, env: o.env });
    const c: any = new EventEmitter();
    c.stdout = new PassThrough(); c.stderr = new PassThrough();
    c.stdin = new Writable({ write: (chunk, _e, cb) => { const out = answer(JSON.parse(chunk.toString())); if (out) c.stdout.write(out + '\n'); cb(); } });
    c.kill = () => true;
    return c;
  });
  return { spawn, calls };
}

describe('Claude usage without the token (get_usage)', () => {
  test('one control request, no model turn, no token; the windows are recorded', async () => {
    const { spawn, calls } = fakeClaude((req) => {
      expect(req).toEqual({ type: 'control_request', request_id: 'dispatch-usage', request: { subtype: 'get_usage', skip_behaviors: true } });
      return JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'dispatch-usage', response: { subscription_type: 'max', rate_limits: { five_hour: { utilization: 13, resets_at: 1_900_000_000 }, seven_day: { utilization: 40.5, resets_at: '2030-01-01T00:00:00Z' } }, limits: [] } } });
    });
    const record = vi.fn();
    const probe = createClaudeGetUsageProbe({ snapshots: { record } as any, accountFor: () => 'claude-code', env: () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-x' }), spawn: spawn as any });
    expect(await probe()).toBe(true);
    expect(calls[0].args).toEqual(GET_USAGE_ARGS);
    expect(calls[0].args).not.toContain('--model');
    expect(calls[0].env.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
    const windows = record.mock.calls[0][2];
    expect(windows.five_hour).toEqual({ usedPercent: 13, resetsAt: 1_900_000_000_000 });
    expect(windows.seven_day.usedPercent).toBe(40.5);
  });

  test('an error answer or an unknown shape records nothing', async () => {
    const record = vi.fn();
    const err = fakeClaude(() => JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: 'dispatch-usage', error: 'nope' } }));
    expect(await createClaudeGetUsageProbe({ snapshots: { record } as any, accountFor: () => 'x', env: () => ({}), spawn: err.spawn as any })()).toBe(false);
    const odd = fakeClaude(() => JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'dispatch-usage', response: {} } }));
    expect(await createClaudeGetUsageProbe({ snapshots: { record } as any, accountFor: () => 'x', env: () => ({}), spawn: odd.spawn as any })()).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  test('a CLI that never answers times out', async () => {
    const { spawn } = fakeClaude(() => null);
    expect(await createClaudeGetUsageProbe({ snapshots: { record: vi.fn() } as any, accountFor: () => 'x', env: () => ({}), spawn: spawn as any, timeoutMs: 20 })()).toBe(false);
  });

  test('windowsFromGetUsage clamps and skips empty windows', () => {
    expect(windowsFromGetUsage({ rate_limits: { five_hour: { utilization: 130 }, x: {} } })).toEqual({ five_hour: { usedPercent: 100, resetsAt: null } });
  });
});
