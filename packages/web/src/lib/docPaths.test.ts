import { describe, it, expect } from 'vitest';
import { findDocPaths, docName, projectForPath } from './docPaths';

const paths = (t: string) => findDocPaths(t).map((s) => [s.path, s.branch]);

describe('findDocPaths', () => {
  it('bare and inline-code paths, with trailing punctuation removed', () => {
    expect(paths('See docs/plans/a.md, then `docs/specs/b-design.md`.')).toEqual([['docs/plans/a.md', null], ['docs/specs/b-design.md', null]]);
    expect(paths('(docs/plans/c.md)')).toEqual([['docs/plans/c.md', null]]);
  });
  it('absolute paths and the (branch ...) part', () => {
    expect(paths('Doc: /w/dispatch/.worktrees/x/docs/specs/x.md (branch spec/x)')).toEqual([['/w/dispatch/.worktrees/x/docs/specs/x.md', 'spec/x']]);
  });
  it('only .md, .markdown and .txt; URLs are left alone', () => {
    expect(paths('a.json b.ts notes.txt README.markdown')).toEqual([['notes.txt', null], ['README.markdown', null]]);
    expect(paths('https://example.com/docs/a.md')).toEqual([]);
  });
  it('the span covers the path only', () => {
    const t = 'x docs/a.md.';
    const [s] = findDocPaths(t);
    expect(t.slice(s.start, s.end)).toBe('docs/a.md');
  });
  it('a long URL leaves every part alone', () => {
    expect(paths('see https://example.com/a/very/long/path/to/docs/specs/a.md and http://x.io/b.txt')).toEqual([]);
    expect(paths('https://example.com/view?file=docs/a.md')).toEqual([]);
  });
  it('a longer name is not a doc path; ./ and ../ paths are', () => {
    expect(paths('a.md.bak b.mdx ./c.md ../d.txt')).toEqual([['./c.md', null], ['../d.txt', null]]);
  });
});

describe('projectForPath', () => {
  const projects = [{ id: 's1', folder: '/w/dispatch' }, { id: 's2', folder: '/w/dispatch-web' }];
  it('an absolute path picks the longest folder match; a relative path uses the message project', () => {
    expect(projectForPath('/w/dispatch-web/docs/a.md', null, projects)).toBe('s2');
    expect(projectForPath('/w/dispatch/docs/a.md', 's2', projects)).toBe('s1');
    expect(projectForPath('docs/a.md', 's2', projects)).toBe('s2');
    expect(projectForPath('docs/a.md', null, projects)).toBeNull();
    expect(projectForPath('/elsewhere/a.md', null, projects)).toBeNull();
  });
  it('docName', () => { expect(docName('/a/b/c-design.md')).toBe('c-design.md'); });
});
