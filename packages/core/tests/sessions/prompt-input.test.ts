import { describe, it, expect } from 'vitest';
import { PromptInput } from '../../src/sessions/prompt-input.js';
describe('first terminal prompt capture', () => {
  it('collects typed chunks and corrections only when submitted', () => {
    const input = new PromptInput();
    expect(input.feed('fix logni')).toEqual([]);
    expect(input.feed('\x7f\x7fin\r')).toEqual(['fix login']);
  });
  it('keeps multiline bracketed paste until enter', () => {
    const input = new PromptInput();
    expect(input.feed('\x1b[200~fix login\nand tests\x1b[201~')).toEqual([]);
    expect(input.feed('\r')).toEqual(['fix login\nand tests']);
  });
  it('does not guess after cursor/history editing or canceled input', () => {
    const input = new PromptInput();
    expect(input.feed('wrong\x1b[A\r')).toEqual([]);
    expect(input.feed('wrong\x03right\r')).toEqual(['right']);
  });
});
