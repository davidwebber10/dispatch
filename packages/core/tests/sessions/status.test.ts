import { describe, it, expect } from 'vitest';
import { mapHookEventToStatus } from '../../src/sessions/status.js';

describe('mapHookEventToStatus', () => {
  it('maps UserPromptSubmit to working', () => {
    expect(mapHookEventToStatus('UserPromptSubmit')).toBe('working');
  });
  it('maps Stop to waiting', () => {
    expect(mapHookEventToStatus('Stop')).toBe('waiting');
  });
  it('maps Notification to needs_input', () => {
    expect(mapHookEventToStatus('Notification')).toBe('needs_input');
  });
  it('returns null for unknown events', () => {
    expect(mapHookEventToStatus('Unknown')).toBeNull();
  });
});
