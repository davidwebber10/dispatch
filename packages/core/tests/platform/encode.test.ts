import { describe, expect, test } from 'vitest';
import { encodeClaudeProjectDir } from '../../src/platform/encode.js';

describe('encodeClaudeProjectDir', () => {
  test('darwin: replaces "/" with "-" (unchanged from current behavior)', () => {
    expect(encodeClaudeProjectDir('/Users/jdetamore/proj', 'darwin')).toBe('-Users-jdetamore-proj');
  });
});
