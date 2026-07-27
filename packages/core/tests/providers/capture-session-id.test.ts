// The PTY fallback watcher adopts the .jsonl born after our spawn. With TWO candidates in
// the window, "newest" can't be attributed to our spawn — a user starting their own claude
// in the same project dir would be adopted. Bail instead; the status-hook capture is the
// authoritative id source and the watcher is only a fallback.
import { describe, it, expect } from 'vitest';
import { pickBornSession } from '../../src/providers/claude-code.js';

const MIN = 1_000_000;

describe('pickBornSession', () => {
  it('returns null (keep polling) when nothing was born in the window', () => {
    expect(pickBornSession([{ name: 'old.jsonl', birth: MIN - 5_000 }], MIN)).toBeNull();
  });

  it('adopts a single in-window birth', () => {
    expect(pickBornSession([
      { name: 'old.jsonl', birth: MIN - 5_000 },
      { name: 'mine.jsonl', birth: MIN + 400 },
    ], MIN)).toEqual({ id: 'mine' });
  });

  it("returns 'ambiguous' when 2+ births land in the window (user's concurrent session)", () => {
    expect(pickBornSession([
      { name: 'mine.jsonl', birth: MIN + 400 },
      { name: 'users.jsonl', birth: MIN + 900 },
    ], MIN)).toBe('ambiguous');
  });
});
