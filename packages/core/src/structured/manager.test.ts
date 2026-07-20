// packages/core/src/structured/manager.test.ts
import { describe, it, expect } from 'vitest';
import { looksLikeQuestion } from '../status/question.js';

describe('looksLikeQuestion wiring contract', () => {
  it('is the backstop the manager uses for an undeclared question turn', () => {
    expect(looksLikeQuestion('Rewired the rail. Does that look right?')).toBe(true);
    expect(looksLikeQuestion('Rewired the rail. All tests pass.')).toBe(false);
  });
});
