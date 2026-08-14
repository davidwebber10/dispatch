import { describe, it, expect } from 'vitest';
import { _AUTH_PROBES } from '../../src/setup/detect.js';

/**
 * Every fixture here is real output, captured from the installed CLI. The point of asking
 * the CLI rather than looking for its credential file is that a file only disappears on an
 * explicit logout — an EXPIRED token leaves it in place, and Dispatch would keep reporting
 * "signed in" until the thread dead-ended on a login screen.
 */
describe('claude auth status --json', () => {
  const read = _AUTH_PROBES.claude.read;

  it('reads a real signed-in payload', () => {
    expect(read(JSON.stringify({
      loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
      email: 'someone@example.com', subscriptionType: 'max',
    }))).toBe(true);
  });

  it('reads a signed-out payload', () => {
    expect(read('{"loggedIn": false}')).toBe(false);
  });

  it('says unknown rather than guessing when the shape changes', () => {
    expect(read('{"authenticated": true}')).toBe('unknown');
    expect(read('not json at all')).toBe('unknown');
    expect(read('')).toBe('unknown');
  });
});

describe('codex login status', () => {
  const read = _AUTH_PROBES.codex.read;

  it('reads the real signed-in line', () => {
    expect(read('Logged in using ChatGPT\n')).toBe(true);
  });

  it('reads signed-out phrasings', () => {
    expect(read('Not logged in')).toBe(false);
    expect(read('You are not authenticated.')).toBe(false);
    expect(read('No credentials found')).toBe(false);
  });

  it('prefers the negative when both words appear', () => {
    // "Not logged in" contains "logged in"; the negative must win or a signed-out CLI
    // would read as signed in.
    expect(read('Not logged in. Run `codex login` to log in.')).toBe(false);
  });

  it('says unknown for unrecognised output', () => {
    expect(read('usage: codex login [options]')).toBe('unknown');
  });
});

describe('grok models', () => {
  const read = _AUTH_PROBES.grok.read;

  it('reads the real signed-out output', () => {
    expect(read('You are not authenticated.\n\nDefault model: grok-4.5\n')).toBe(false);
  });

  it('treats a model listing with no complaint as signed in', () => {
    expect(read('Default model: grok-4.5\n\nAvailable models:\n  * grok-4.5 (default)\n')).toBe(true);
  });

  it('says unknown when it printed neither', () => {
    expect(read('error: connection refused')).toBe('unknown');
  });
});

describe('every provider has a probe', () => {
  it('covers all three CLIs with a command and a reader', () => {
    for (const name of ['claude', 'codex', 'grok'] as const) {
      expect(_AUTH_PROBES[name].args.length).toBeGreaterThan(0);
      expect(typeof _AUTH_PROBES[name].read).toBe('function');
    }
  });
});
