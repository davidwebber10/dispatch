import { describe, it, expect } from 'vitest';
import { redactKeys, redactKeysDeep } from './redact-keys.js';

const B = (c: string) => c.repeat(43).slice(0, 43);
const T = 'dtk_' + B('a');
const C = 'dck_' + B('b-');
const S = 'dsk_' + B('_');

describe('redactKeys', () => {
  it('redacts a key in a sentence', () => {
    expect(redactKeys(`use ${T} now`)).toBe('use dtk_[redacted] now');
  });
  it('redacts two keys on one line', () => {
    expect(redactKeys(`${T} ${S}`)).toBe('dtk_[redacted] dsk_[redacted]');
  });
  it('redacts at the end of a line', () => {
    expect(redactKeys(`a\nkey=${C}\nb`)).toBe('a\nkey=dck_[redacted]\nb');
  });
  it('redacts inside JSON text', () => {
    expect(redactKeys(JSON.stringify({ k: T }))).toBe('{"k":"dtk_[redacted]"}');
  });
  it('redacts a key after a tab, a newline, a JSON escape or a %20 escape', () => {
    expect(redactKeys(`line1\n${T}`)).toBe('line1\ndtk_[redacted]');
    expect(redactKeys(`a\t${T}`)).toBe('a\tdtk_[redacted]');
    expect(redactKeys(`{"t":"line1\\n${T}"}`)).toBe('{"t":"line1\\ndtk_[redacted]"}');
    expect(redactKeys(`Authorization:%20Bearer%20${T}`)).toBe('Authorization:%20Bearer%20dtk_[redacted]');
  });
  it('leaves a non-key alone', () => {
    expect(redactKeys('xdtk_abc and Bearer%20dtk_short')).toBe('xdtk_abc and Bearer%20dtk_short');
    expect(redactKeys('dtk_abc and dck_')).toBe('dtk_abc and dck_');
  });
  it('does not leave a tail when the body is too long', () => {
    expect(redactKeys(T + 'A')).toBe(T + 'A');
  });
});

describe('redactKeysDeep', () => {
  it('walks arrays and objects without mutating', () => {
    const input = { a: [T, { b: `x ${S}` }], n: 3, z: null, t: true };
    const copy = JSON.parse(JSON.stringify(input));
    const out = redactKeysDeep(input);
    expect(out).toEqual({ a: ['dtk_[redacted]', { b: 'x dsk_[redacted]' }], n: 3, z: null, t: true });
    expect(input).toEqual(copy);
    expect(out).not.toBe(input);
  });
  it('leaves null and numbers unchanged', () => {
    expect(redactKeysDeep(null)).toBeNull();
    expect(redactKeysDeep(7)).toBe(7);
  });
});
