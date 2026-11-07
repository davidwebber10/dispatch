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

it('names a plugin creator by its name, else by its id (2026-11-07)', () => {
  expect(describeCreator({ kind: 'plugin', pluginId: 'daily-rundown', name: 'Daily rundown' })).toBe('Plugin: Daily rundown');
  expect(describeCreator({ kind: 'plugin', pluginId: 'daily-rundown', name: null })).toBe('Plugin: daily-rundown');
});
