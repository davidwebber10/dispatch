import { describe, it, expect } from 'vitest';
import { normalizeClaude, normalizeCodex } from '../../src/status/events.js';

describe('normalizeClaude', () => {
  const ev = (o: object) => ({ session_id: 'sid-1', cwd: '/x', ...o });

  it('captures session_id on every event', () => {
    expect(normalizeClaude(ev({ hook_event_name: 'SessionStart' })).sessionId).toBe('sid-1');
    expect(normalizeClaude(ev({ hook_event_name: 'Stop' })).sessionId).toBe('sid-1');
  });

  it('maps lifecycle events to statuses', () => {
    expect(normalizeClaude(ev({ hook_event_name: 'SessionStart' })).status).toBe('starting');
    expect(normalizeClaude(ev({ hook_event_name: 'UserPromptSubmit' })).status).toBe('working');
    expect(normalizeClaude(ev({ hook_event_name: 'Stop' })).status).toBe('idle');
    expect(normalizeClaude(ev({ hook_event_name: 'SessionEnd' })).status).toBe('done');
    expect(normalizeClaude(ev({ hook_event_name: 'StopFailure', error_type: 'rate_limit' })).status).toBe('error');
  });

  it('distinguishes permission vs idle notifications', () => {
    expect(normalizeClaude(ev({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }))).toMatchObject({ status: 'needs_input', activity: 'Waiting for approval' });
    expect(normalizeClaude(ev({ hook_event_name: 'Notification', notification_type: 'idle_prompt' })).status).toBe('idle');
  });

  it('builds a tool activity label for PreToolUse', () => {
    expect(normalizeClaude(ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } })))
      .toMatchObject({ status: 'working', activity: 'Running: npm test' });
    expect(normalizeClaude(ev({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/a/b/app.ts' } })).activity)
      .toBe('Edit app.ts');
  });

  it('PermissionRequest -> needs_input', () => {
    expect(normalizeClaude(ev({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' })).status).toBe('needs_input');
  });

  it('unknown events do not change status but keep sessionId', () => {
    expect(normalizeClaude(ev({ hook_event_name: 'CwdChanged' }))).toEqual({ status: null, sessionId: 'sid-1' });
  });
});

describe('normalizeCodex', () => {
  it('turn-complete -> idle and captures thread-id', () => {
    expect(normalizeCodex({ type: 'agent-turn-complete', 'thread-id': 'th-9', 'last-assistant-message': 'ok' }))
      .toMatchObject({ status: 'idle', sessionId: 'th-9' });
  });
  it('other types -> no status change', () => {
    expect(normalizeCodex({ type: 'something-else', 'thread-id': 'th-9' })).toEqual({ status: null, sessionId: 'th-9' });
  });
});
