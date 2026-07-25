import { describe, expect, test } from 'vitest';
import { normalizeBasePath, stripPrefix, indexHtmlWithBase } from './server.js';

describe('normalizeBasePath', () => {
  test('unset / root means no prefix', () => {
    expect(normalizeBasePath(undefined)).toBe('');
    expect(normalizeBasePath('')).toBe('');
    expect(normalizeBasePath('/')).toBe('');
  });

  test('normalizes leading and trailing slashes', () => {
    expect(normalizeBasePath('/u/dwebber/dispatch')).toBe('/u/dwebber/dispatch');
    expect(normalizeBasePath('u/dwebber/dispatch')).toBe('/u/dwebber/dispatch');
    expect(normalizeBasePath('/u/dwebber/dispatch/')).toBe('/u/dwebber/dispatch');
  });
});

describe('stripPrefix', () => {
  const B = '/u/dwebber/dispatch';

  test('passes everything through when no prefix is configured', () => {
    expect(stripPrefix('/api/sessions', '')).toBe('/api/sessions');
  });

  test('strips the prefix from API and WS paths', () => {
    expect(stripPrefix(`${B}/api/sessions`, B)).toBe('/api/sessions');
    expect(stripPrefix(`${B}/api/events`, B)).toBe('/api/events');
    expect(stripPrefix(`${B}/api/terminals/t1/ws?replayBytes=8192`, B))
      .toBe('/api/terminals/t1/ws?replayBytes=8192');
  });

  test('the bare mount point is the app root', () => {
    expect(stripPrefix(B, B)).toBe('/');
    expect(stripPrefix(`${B}/`, B)).toBe('/');
  });

  test('rejects paths outside the mount point', () => {
    expect(stripPrefix('/api/sessions', B)).toBeNull();
    expect(stripPrefix('/u/someone-else/dispatch/api/sessions', B)).toBeNull();
  });

  test('a path that merely shares the prefix string is not a match', () => {
    // Guards against a naive startsWith: this must not be treated as /evil-suffix.
    expect(stripPrefix(`${B}-evil/api/sessions`, B)).toBeNull();
    expect(stripPrefix(`${B}foo`, B)).toBeNull();
  });
});

describe('indexHtmlWithBase', () => {
  const html = '<head><meta charset="utf-8" /><base href="/" /><title>D</title></head>';

  test('rewrites the base tag to the mount prefix with a trailing slash', () => {
    // The trailing slash matters: <base href="/u/x/dispatch"> would resolve
    // "assets/x.js" against /u/x/ and drop the last segment.
    expect(indexHtmlWithBase(html, '/u/dwebber/dispatch'))
      .toContain('<base href="/u/dwebber/dispatch/">');
  });

  test('root deployment keeps a plain slash', () => {
    expect(indexHtmlWithBase(html, '')).toContain('<base href="/">');
  });

  test('leaves the rest of the document alone', () => {
    expect(indexHtmlWithBase(html, '/u/x/dispatch')).toContain('<title>D</title>');
  });
});
