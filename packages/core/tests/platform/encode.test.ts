import { describe, expect, test } from 'vitest';
import { encodeClaudeProjectDir } from '../../src/platform/encode.js';

describe('encodeClaudeProjectDir', () => {
  test('darwin: replaces "/" with "-" (unchanged from current behavior)', () => {
    expect(encodeClaudeProjectDir('/Users/jdetamore/proj', 'darwin')).toBe('-Users-jdetamore-proj');
  });
  test('win32: replaces drive colon and backslashes with "-"', () => {
    // NOTE: must match Windows Claude Code's real encoding — confirm during bring-up.
    expect(encodeClaudeProjectDir('C:\\Users\\jdetamore\\proj', 'win32')).toBe('C--Users-jdetamore-proj');
  });
});
