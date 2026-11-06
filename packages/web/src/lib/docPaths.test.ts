import { describe, it, expect } from 'vitest';
import { findDocPaths, docName, projectForPath, resolveProjectPath, fileKind } from './docPaths';

const paths = (t: string) => findDocPaths(t).map((s) => [s.path, s.branch]);

describe('findDocPaths', () => {
  it('bare and inline-code paths, with trailing punctuation removed', () => {
    expect(paths('See docs/plans/a.md, then `docs/specs/b-design.md`.')).toEqual([['docs/plans/a.md', null], ['docs/specs/b-design.md', null]]);
    expect(paths('(docs/plans/c.md)')).toEqual([['docs/plans/c.md', null]]);
  });
  it('absolute paths and the (branch ...) part', () => {
    expect(paths('Doc: /w/dispatch/.worktrees/x/docs/specs/x.md (branch spec/x)')).toEqual([['/w/dispatch/.worktrees/x/docs/specs/x.md', 'spec/x']]);
  });
  it('URLs are left alone', () => {
    expect(paths('https://example.com/docs/a.md')).toEqual([]);
    expect(paths('https://example.com/a/b.py and http://x.io/c.json')).toEqual([]);
  });
  it('any file type is a path: code, data, images, pdf', () => {
    expect(paths('Run `scripts/extract.py` on /w/app/data/out.xlsx, then src/a.tsx and img/shot.PNG.')).toEqual([
      ['scripts/extract.py', null], ['/w/app/data/out.xlsx', null], ['src/a.tsx', null], ['img/shot.PNG', null],
    ]);
    expect(paths('see report.pdf, data.parquet, run.sh, config.yml and package.json')).toEqual([
      ['report.pdf', null], ['data.parquet', null], ['run.sh', null], ['config.yml', null], ['package.json', null],
    ]);
    expect(paths('Makefile.am docs/notes.weirdext')).toEqual([['docs/notes.weirdext', null]]);
  });
  it('domains, versions, emails and abbreviations are not paths', () => {
    expect(paths('Email jo@example.com or visit example.com and www.example.com/about.html.')).toEqual([]);
    expect(paths('Released v3.19.0 (3.5.2), e.g. this, i.e. that; see Node.js, next.js and socket.io.')).toEqual([]);
    expect(paths('github.com/acme/widgets.git and raw.example.org/x/y.json')).toEqual([]);
    expect(paths('about 1.5x faster, 10/12.5 and 0.95')).toEqual([]);
  });
  it('code that looks like a file name is not a path', () => {
    expect(paths('call `console.log` and res.json(data), then process.env.HOME and Math.max')).toEqual([]);
    expect(paths('open package.json (the manifest)')).toEqual([['package.json', null]]);
  });
  it('a ./ or / path to a file with a TLD-like name is still a path only when the extension is a file type', () => {
    expect(paths('./build/index.js and /w/app/main.rs')).toEqual([['./build/index.js', null], ['/w/app/main.rs', null]]);
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
  it('a path after @ or ~ in the same word is not a doc path', () => {
    expect(paths('~/docs/a.md')).toEqual([]);
  });
});

// Each input must finish well under a second. The bound is generous, so a busy machine does not fail it.
const timed = (t: string) => { const t0 = performance.now(); const n = findDocPaths(t).length; return { n, ms: performance.now() - t0 }; };

describe('findDocPaths is linear', () => {
  it.each([
    ['a long word, then one path', 'x'.repeat(100000) + ' a.md', 1],
    ['20000 paths', ' a.md'.repeat(20000), 20000],
    ['a long word, then 200 paths', 'x'.repeat(50000) + ' (a.md)'.repeat(200), 200],
    ['50000 @', '@'.repeat(50000), 0],
    ['25000 @.', '@.'.repeat(25000), 0],
    ['one word of 50000 dotted letters', 'a.'.repeat(25000) + 'b', 0],
    ['10000 dotted words', ' x.y.z'.repeat(10000), 0],
    ['5000 paths with folders', ' src/a.py'.repeat(5000), 5000],
  ])('%s', (_name, text, count) => {
    const { n, ms } = timed(text);
    expect(n).toBe(count);
    expect(ms).toBeLessThan(200);
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


describe('resolveProjectPath', () => {
  const projects = [{ id: 'd', folder: '/w/dispatch' }, { id: 'sb', folder: '/w/sandbox' }, { id: 'a1', folder: '/x/shared' }, { id: 'a2', folder: '/y/shared' }];
  it('a relative path that starts with another known project folder name belongs to that project', () => {
    expect(resolveProjectPath('sandbox/team-requests/board.md', 'd', projects)).toEqual({ project: 'sb', path: 'team-requests/board.md' });
  });
  it('a relative path with no such prefix stays with the message project', () => {
    expect(resolveProjectPath('docs/a.md', 'd', projects)).toEqual({ project: 'd', path: 'docs/a.md' });
  });
  it('the message project\'s own folder name is not stripped', () => {
    expect(resolveProjectPath('dispatch/x/a.py', 'd', projects)).toEqual({ project: 'd', path: 'dispatch/x/a.py' });
  });
  it('a bare folder-name prefix with no file part, or two projects with the same folder name, stays as it is', () => {
    expect(resolveProjectPath('sandbox', 'd', projects)).toEqual({ project: 'd', path: 'sandbox' });
    expect(resolveProjectPath('shared/a.py', 'd', projects)).toEqual({ project: 'd', path: 'shared/a.py' });
  });
  it('an absolute path and a path with no message project follow projectForPath', () => {
    expect(resolveProjectPath('/w/sandbox/a.py', 'd', projects)).toEqual({ project: 'sb', path: '/w/sandbox/a.py' });
    expect(resolveProjectPath('docs/a.md', null, projects)).toBeNull();
    expect(resolveProjectPath('sandbox/a.md', null, projects)).toEqual({ project: 'sb', path: 'a.md' });
    expect(resolveProjectPath('/elsewhere/a.py', 'd', projects)).toBeNull();
  });
});

describe('fileKind', () => {
  it('doc, image, binary and text', () => {
    expect(fileKind('a/b.md')).toBe('doc');
    expect(fileKind('B.MARKDOWN')).toBe('doc');
    expect(fileKind('n.txt')).toBe('doc');
    expect(fileKind('s/x.png')).toBe('image');
    expect(fileKind('x.svg')).toBe('text');
    for (const f of ['a.xlsx', 'a.xls', 'a.parquet', 'a.pdf', 'a.zip', 'a.docx', 'a.sqlite', 'a.tar.gz', 'a.pkl']) expect(fileKind(f)).toBe('binary');
    for (const f of ['a.py', 'a.tsx', 'a.json', 'a.csv', 'a.sql', 'a.sh', 'a.yml', 'a.unknown']) expect(fileKind(f)).toBe('text');
  });
});
