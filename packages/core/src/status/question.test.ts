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

  it('ignores bare "confirm" in a completion report (Finding 1)', () => {
    expect(looksLikeQuestion('Logs confirm the deploy succeeded.')).toBe(false);
    expect(looksLikeQuestion('Tests confirm the fix works.')).toBe(false);
    expect(looksLikeQuestion("I'll confirm this works by running the tests.")).toBe(false);
  });

  it('still catches a narrow, human-addressed confirm ask', () => {
    expect(looksLikeQuestion('Please confirm before I deploy to prod.')).toBe(true);
    expect(looksLikeQuestion('Can you confirm the staging URL is still correct.')).toBe(true);
  });

  it('isolates the closing thought by line in an unpunctuated bullet list (Finding 2)', () => {
    const text = 'Progress:\n- Let me know if refactor A is needed\n- Fixed refactor B\n- Fixed refactor C';
    expect(looksLikeQuestion(text)).toBe(false);
  });

  it('still catches an ask that is genuinely the last bullet', () => {
    const text = 'Progress:\n- Fixed refactor B\n- Fixed refactor C\n- Let me know if refactor A is needed';
    expect(looksLikeQuestion(text)).toBe(true);
  });

  it('requires fence-stripping: an ask-phrase inside a fenced comment must not leak through (Finding 3)', () => {
    const text = 'Added the guard: ```// let me know if this is wrong``` Added the guard above.';
    expect(looksLikeQuestion(text)).toBe(false);
  });

  it('tolerates an unterminated fence (message truncated mid-code-block) (Finding 4)', () => {
    const text = 'Here is progress so far:\n```\nfunction foo() {\n  // let me know if this needs adjusting\n';
    expect(looksLikeQuestion(text)).toBe(false);
  });
});

// Regression: line-splitting on every \n truncated a soft-wrapped ask to its last line,
// so "…let me know if you want changes\nbefore I merge" read as just "before I merge"
// and the ask was missed. Continuations are rejoined; list items still open a new thought.
describe('soft-wrapped closings', () => {
  it('catches an ask that wraps across a line break', () => {
    expect(looksLikeQuestion('I finished the refactor and tests pass. Let me know if you want changes\nbefore I merge this to main.')).toBe(true);
  });

  it('catches an ask wrapped onto an indented continuation', () => {
    expect(looksLikeQuestion("Let me know if you'd like this refactored differently\n    before I proceed further.")).toBe(true);
  });

  it('still does not let an earlier bullet leak into the closing thought', () => {
    expect(looksLikeQuestion('Progress:\n- Let me know if refactor A is needed\n- Fixed refactor B\n- Fixed refactor C')).toBe(false);
  });

  it('treats a numbered item as its own thought, not a continuation', () => {
    expect(looksLikeQuestion('Steps taken\n1. Let me know if this is wrong\n2. Rebuilt the bundle')).toBe(false);
  });

  it('does not join across a completed sentence', () => {
    expect(looksLikeQuestion('Let me know if anything looks off.\nShipped v2.6.0.')).toBe(false);
  });
});
