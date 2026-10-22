import { describe, it, expect } from 'vitest';
import { classifyLink } from './docLinks';

const projects = [{ id: 'p1', folder: '/Users/me/dev/app' }, { id: 'p2', folder: '/Users/me/dev/other' }];
const ctx = { project: 'p1', projects };
const doc = (path: string, project = 'p1') => ({ kind: 'doc', project, path });

describe('classifyLink', () => {
  it('opens an absolute doc path inside the project', () => {
    expect(classifyLink('/Users/me/dev/app/docs/plan.md', ctx)).toEqual(doc('/Users/me/dev/app/docs/plan.md'));
  });
  it('picks the project that owns an absolute path', () => {
    expect(classifyLink('/Users/me/dev/other/notes.txt', ctx)).toEqual(doc('/Users/me/dev/other/notes.txt', 'p2'));
  });
  it('opens a relative doc path in the message project', () => {
    expect(classifyLink('docs/plan.md', ctx)).toEqual(doc('docs/plan.md'));
    expect(classifyLink('./docs/plan.md', ctx)).toEqual(doc('docs/plan.md'));
  });
  it('resolves a relative link against the doc it is in', () => {
    expect(classifyLink('../b.md', { ...ctx, from: 'docs/x/a.md' })).toEqual(doc('docs/b.md'));
    expect(classifyLink('c.md', { ...ctx, from: 'docs/x/a.md' })).toEqual(doc('docs/x/c.md'));
  });
  it('reads a file URL, with or without a host', () => {
    expect(classifyLink('file:///Users/me/dev/app/docs/plan.md', ctx)).toEqual(doc('/Users/me/dev/app/docs/plan.md'));
    expect(classifyLink('file://localhost/Users/me/dev/app/docs/plan.md', ctx)).toEqual(doc('/Users/me/dev/app/docs/plan.md'));
  });
  it('drops a :line, :line:col, #L12 or #L12-L20 suffix and a query', () => {
    for (const s of [':12', ':12:3', '#L12', '#L12-L20', '#heading', '?x=1']) {
      expect(classifyLink(`/Users/me/dev/app/docs/plan.md${s}`, ctx)).toEqual(doc('/Users/me/dev/app/docs/plan.md'));
    }
    expect(classifyLink('file:///Users/me/dev/app/a.md#L3', ctx)).toEqual(doc('/Users/me/dev/app/a.md'));
  });
  it('opens a bare file name with a line suffix', () => {
    expect(classifyLink('plan.md:12', ctx)).toEqual(doc('plan.md'));
    expect(classifyLink('plan.md:12:3', ctx)).toEqual(doc('plan.md'));
  });
  it('decodes a percent-encoded path', () => {
    expect(classifyLink('/Users/me/dev/app/my%20docs/a%20b.md', ctx)).toEqual(doc('/Users/me/dev/app/my docs/a b.md'));
  });
  it('refuses a doc path outside every project', () => {
    expect(classifyLink('/etc/notes.md', ctx)).toEqual({ kind: 'none' });
    expect(classifyLink('/Users/me/dev/app-evil/a.md', ctx)).toEqual({ kind: 'none' });
    expect(classifyLink('file:///Users/me/secret/a.md', ctx)).toEqual({ kind: 'none' });
  });
  it('refuses a relative path that leaves the project', () => {
    expect(classifyLink('../../a.md', ctx)).toEqual({ kind: 'none' });
    expect(classifyLink('/Users/me/dev/app/../x/a.md', ctx)).toEqual({ kind: 'none' });
  });
  it('refuses a relative doc path when there is no project', () => {
    expect(classifyLink('docs/a.md', { project: null, projects })).toEqual({ kind: 'none' });
  });
  it('sends http, https and mailto links to a new tab', () => {
    expect(classifyLink('https://example.com/a.md', ctx)).toEqual({ kind: 'web', href: 'https://example.com/a.md' });
    expect(classifyLink('HTTP://example.com', ctx)).toEqual({ kind: 'web', href: 'HTTP://example.com' });
    expect(classifyLink('mailto:a@b.co', ctx)).toEqual({ kind: 'web', href: 'mailto:a@b.co' });
  });
  it('does nothing for every other target', () => {
    for (const h of ['', '#top', '//evil.com/a.md', 'javascript:alert(1)', 'ftp://h/a.md', 'tel:123', '/Users/me/dev/app/src/a.ts', 'src/a.ts', 'docs/', '/Users/me/dev/app/a.md.bak']) {
      expect(classifyLink(h, ctx), h).toEqual({ kind: 'none' });
    }
  });
});

describe('classifyLink: a link to the app itself plus a path', () => {
  const p = '/Users/me/dev/app/docs/plan.md';
  it('reads a loopback, LAN or Tailscale host with a path as the file path', () => {
    for (const host of ['localhost:3456', '127.0.0.1:3456', '[::1]:3456', '192.168.1.20:3456', '10.0.0.5:3456', '100.101.102.103:3456', 'mac-mini.tail1234.ts.net:3456', 'mac-mini.local:3456']) {
      expect(classifyLink(`http://${host}${p}`, ctx), host).toEqual(doc(p));
    }
    expect(classifyLink(`https://mac-mini.tail1234.ts.net${p}`, ctx)).toEqual(doc(p));
  });
  it('drops a line, a fragment and a query, and decodes the path', () => {
    expect(classifyLink(`http://localhost:3456${p}#L12`, ctx)).toEqual(doc(p));
    expect(classifyLink(`http://localhost:3456${p}?x=1`, ctx)).toEqual(doc(p));
    expect(classifyLink('http://localhost:3456/Users/me/dev/app/my%20plan.md', ctx)).toEqual(doc('/Users/me/dev/app/my plan.md'));
  });
  it('does nothing when the path is in no project (it would only load the app)', () => {
    expect(classifyLink('http://localhost:3456/etc/notes.md', ctx)).toEqual({ kind: 'none' });
    expect(classifyLink('http://localhost:3456/Users/me/dev/app/../../../etc/x.md', ctx)).toEqual({ kind: 'none' });
  });
  it('keeps a web link to another host, and an own-host link to a non-doc, as web', () => {
    expect(classifyLink(`https://example.com${p}`, ctx)).toEqual({ kind: 'web', href: `https://example.com${p}` });
    expect(classifyLink('https://github.com/o/r/blob/main/docs/plan.md', ctx).kind).toBe('web');
    expect(classifyLink('http://localhost:3456/api/sessions', ctx).kind).toBe('web');
    expect(classifyLink('http://localhost:3456/', ctx).kind).toBe('web');
  });
});
