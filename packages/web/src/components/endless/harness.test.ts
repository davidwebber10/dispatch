import { describe, it, expect } from 'vitest';
import { harnessShort } from './harness';

describe('harnessShort', () => {
  it('drops the Code / CLI suffix from the catalog label', () => {
    expect(harnessShort('claude-code')).toBe('Claude');
    expect(harnessShort('codex')).toBe('Codex');
  });
  it('returns an unknown type as it is', () => {
    expect(harnessShort('mystery')).toBe('mystery');
  });
});
