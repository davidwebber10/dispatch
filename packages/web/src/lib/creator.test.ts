import { describe, it, expect } from 'vitest';
import { describeCreator } from './creator';

describe('describeCreator', () => {
  it('shows a row with no record as Unknown', () => {
    expect(describeCreator(null)).toBe('Unknown');
    expect(describeCreator(undefined)).toBe('Unknown');
  });
  it('names each kind of creator', () => {
    expect(describeCreator({ kind: 'owner' })).toBe('Owner (signed in)');
    expect(describeCreator({ kind: 'local' })).toBe('Local, no sign-in');
    expect(describeCreator({ kind: 'tailscale' })).toBe('Tailscale, no sign-in');
    expect(describeCreator({ kind: 'chat' })).toBe('Chat');
  });
  it('names a thread by its name, else by a short id', () => {
    expect(describeCreator({ kind: 'thread', terminalId: 'abcdef123456', name: 'Fix login' })).toBe('Thread: Fix login');
    expect(describeCreator({ kind: 'thread', terminalId: 'abcdef123456', name: null })).toBe('Thread: thread abcdef12');
    expect(describeCreator({ kind: 'shell', terminalId: 'abcdef123456', name: 'Fix login' })).toBe('Shell in Fix login');
  });
});
