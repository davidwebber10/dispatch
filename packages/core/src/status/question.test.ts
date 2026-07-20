import { describe, it, expect } from 'vitest';
import { looksLikeQuestion } from './question.js';

describe('looksLikeQuestion', () => {
  it('catches a trailing question mark', () => {
    expect(looksLikeQuestion('I refactored the rail. Does that look right?')).toBe(true);
  });

  it('catches an ask with no question mark', () => {
    expect(looksLikeQuestion('I can go either way here — let me know which you prefer.')).toBe(true);
    expect(looksLikeQuestion('Before I continue I need the staging credentials.')).toBe(true);
  });

  it('ignores a question that is not the last thing said', () => {
    // The model posed a rhetorical question mid-answer and then finished the work.
    expect(looksLikeQuestion('Why does this fail? Because the guard runs first. Fixed in a04695f.')).toBe(false);
  });

  it('ignores a plain completion report', () => {
    expect(looksLikeQuestion('Merged to main. 6 commits, all tests green.')).toBe(false);
    expect(looksLikeQuestion('Done — shipped v2.6.0.')).toBe(false);
  });

  it('ignores a question inside a code block', () => {
    expect(looksLikeQuestion('Added the guard:\n```\nif (!ok) throw new Error("who?");\n```')).toBe(false);
  });

  it('is safe on empty and whitespace input', () => {
    expect(looksLikeQuestion('')).toBe(false);
    expect(looksLikeQuestion('   \n  ')).toBe(false);
  });
});
