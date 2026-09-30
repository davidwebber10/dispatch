import { describe, expect, test } from 'vitest';
import { usableToken } from '../src/doppler-client.js';

// A CR, LF, or NUL inside the token makes fetch throw an error that quotes the whole
// Authorization header, so index.ts refuses such a token at startup.
describe('usableToken', () => {
  test('keeps a plain token', () => {
    expect(usableToken('dp.st.fake')).toBe('dp.st.fake');
  });

  test('trims surrounding whitespace, so a token read from a file with a trailing newline still works', () => {
    expect(usableToken(' dp.st.fake\n')).toBe('dp.st.fake');
    expect(usableToken('dp.st.fake\r\n')).toBe('dp.st.fake');
  });

  test('refuses a CR, LF, or NUL inside the token', () => {
    expect(usableToken('dp.st.fake\ninvalid')).toBeNull();
    expect(usableToken('dp.st.fake\rinvalid')).toBeNull();
    expect(usableToken('dp.st.fake\0invalid')).toBeNull();
  });

  test('refuses an empty or whitespace-only token', () => {
    expect(usableToken('')).toBeNull();
    expect(usableToken(' \n')).toBeNull();
  });
});
