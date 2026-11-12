import { describe, expect, test } from 'vitest';
import { canonicalPathProblem } from './canonical-path.js';

describe('canonical request paths', () => {
  test.each([
    '/', '/api/sessions', '/api/sessions/abc-123/terminals', '/api/sessions?path=%2Fetc%2F..%2Fx',
    '/api/plugins/previews/data/preview%3A12', '/api/endless/media/a%20b.png', '/assets/index-abc.js',
    '/some/page/', '/Settings', '/plugins/previews/web.js?v=3', '/api/terminals/t1/blocked/toolu_01AbC',
    '/api/sessions/x/files/read?path=a/../b', '/api/secrets/50%25/value',
  ])('%s is canonical', (p) => { expect(canonicalPathProblem(p)).toBeNull(); });

  test.each([
    ['api/sessions', 'not_absolute'],
    ['/api//sessions', 'empty_segment'],
    ['//api/sessions', 'empty_segment'],
    ['/api/./sessions', 'dot_segment'],
    ['/api/../api/sessions', 'dot_segment'],
    ['/api/sessions/..', 'dot_segment'],
    ['/api/sessions\\x', 'forbidden_character'],
    ['/api/sessions;a=b', 'forbidden_character'],
    ['/api/sessions/\u0001', 'forbidden_character'],
    ['/api/ｓessions', 'forbidden_character'],
    ['/api/sessions/a b', 'forbidden_character'],
    ['/api/sessions/%zz', 'bad_escape'],
    ['/api/sessions/%2', 'bad_escape'],
    ['/api/sessions%2fx', 'encoded_separator'],
    ['/api/sessions%2Fx', 'encoded_separator'],
    ['/api/sessions%5cx', 'encoded_separator'],
    ['/api/%2e%2e/sessions', 'encoded_separator'],
    ['/api/sessions%00', 'encoded_separator'],
    ['/api/sessions%0a', 'encoded_separator'],
    ['/api/sessions%3bx', 'encoded_separator'],
    ['/%61pi/sessions', 'needless_escape'],
    ['/api/session%73', 'needless_escape'],
    ['/api/sessions/%252f', 'double_encoded'],
    ['/API/sessions', 'prefix_case'],
    ['/Api/sessions', 'prefix_case'],
    ['/api/sessions/', 'trailing_slash'],
    ['/api/', 'trailing_slash'],
    ['/plugins/x/', 'trailing_slash'],
    ['/api/sessions/%ff', 'bad_escape'],
  ])('%s is refused (%s)', (p, why) => { expect(canonicalPathProblem(p)).toBe(why); });

  test('the tail of a plugin worker path belongs to the worker; its head is checked like every path', () => {
    expect(canonicalPathProblem('/api/plugins/open/worker/files/a%20b/c%2Fd?q=x%20y')).toBeNull();
    expect(canonicalPathProblem('/api/plugins/open/worker/')).toBeNull();
    expect(canonicalPathProblem('/api/plugins/open/worker')).toBeNull();
    expect(canonicalPathProblem('/api/plugins/open/worker/a/../../../sessions')).toBe('dot_segment');
    expect(canonicalPathProblem('/api/plugins/open/worker//a')).toBe('empty_segment');
    expect(canonicalPathProblem('/api/plugins/open/worker/a%00')).toBe('encoded_separator');
    expect(canonicalPathProblem('/api/Plugins/open/worker/a%2Fb')).toBe('encoded_separator'); // not the worker route: no exception
    expect(canonicalPathProblem('/API/plugins/open/worker/a')).toBe('prefix_case');
    expect(canonicalPathProblem('/api/plugins/op%65n/worker/a')).toBe('needless_escape');
  });

  test('the query string is not part of the path', () => {
    expect(canonicalPathProblem('/api/x?a=//&b=%2f..%5c;')).toBeNull();
  });
});
