import { describe, it, expect } from 'vitest';
import { expandUntrackedDirs, parsePorcelainZ } from './git.js';

// Records come straight from `git status --porcelain -z`: NUL-terminated,
// paths verbatim (no quoting), and a rename carries the OLD path as an extra field.
const z = (...recs: string[]) => recs.join('\0') + '\0';

describe('parsePorcelainZ', () => {
  it('maps the common cases to one UI letter each', () => {
    const files = parsePorcelainZ(z(' M packages/web/src/App.tsx', 'A  new.ts', ' D gone.ts', '?? scratch.txt'));
    expect(files).toEqual([
      { path: 'packages/web/src/App.tsx', status: 'M' },
      { path: 'new.ts', status: 'A' },
      { path: 'gone.ts', status: 'D' },
      { path: 'scratch.txt', status: '?' },
    ]);
  });

  it('consumes the rename old-path field so the next record is not misread', () => {
    const files = parsePorcelainZ(z('R  renamed.ts', 'old.ts', ' M other.ts'));
    expect(files).toEqual([
      { path: 'renamed.ts', status: 'R' },
      { path: 'other.ts', status: 'M' },
    ]);
  });

  it('keeps paths with spaces intact and ignores the trailing empty field', () => {
    const files = parsePorcelainZ(z(' M docs/My Notes.md'));
    expect(files).toEqual([{ path: 'docs/My Notes.md', status: 'M' }]);
  });

  it('returns [] for empty output', () => {
    expect(parsePorcelainZ('')).toEqual([]);
  });
});

describe('expandUntrackedDirs', () => {
  it('replaces dir/ records with the files ls-files reports beneath them', () => {
    const files = parsePorcelainZ(z(' M src/app.ts', '?? scratchpad/'));
    const out = expandUntrackedDirs(files, 'scratchpad/a.csv\0scratchpad/sub/b.txt\0');
    expect(out).toEqual([
      { path: 'src/app.ts', status: 'M' },
      { path: 'scratchpad/a.csv', status: '?' },
      { path: 'scratchpad/sub/b.txt', status: '?' },
    ]);
  });

  it('does not duplicate a file porcelain already listed individually', () => {
    const files = parsePorcelainZ(z('?? loose.txt', '?? scratchpad/'));
    const out = expandUntrackedDirs(files, 'loose.txt\0scratchpad/a.csv\0');
    expect(out).toEqual([
      { path: 'loose.txt', status: '?' },
      { path: 'scratchpad/a.csv', status: '?' },
    ]);
  });

  it('drops an empty dir record when ls-files returns nothing for it', () => {
    const files = parsePorcelainZ(z('?? scratchpad/'));
    expect(expandUntrackedDirs(files, '')).toEqual([]);
  });
});
