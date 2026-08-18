import { describe, it, expect } from 'vitest';
import { fuzzyMatch, fuzzyFilter } from './fuzzy';

describe('fuzzyMatch', () => {
  it('matches a substring and returns contiguous indices', () => {
    const m = fuzzyMatch('read', 'README.md');
    expect(m).not.toBeNull();
    expect(m!.indices).toEqual([0, 1, 2, 3]);
  });

  it('is case-insensitive', () => {
    expect(fuzzyMatch('APP', 'src/app.tsx')).not.toBeNull();
  });

  it('matches an in-order subsequence with gaps', () => {
    const m = fuzzyMatch('fpane', 'src/components/FilesPane.tsx');
    expect(m).not.toBeNull();
    // indices strictly increase — that's what the highlighter relies on
    const idx = m!.indices;
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('rejects out-of-order characters', () => {
    expect(fuzzyMatch('enap', 'pane')).toBeNull();
  });

  it('ranks a basename hit above a directory-only hit', () => {
    const ranked = fuzzyFilter('app', ['app/config.ts', 'src/App.tsx']);
    expect(ranked[0].path).toBe('src/App.tsx');
  });

  it('ranks substring hits above scattered subsequence hits', () => {
    const ranked = fuzzyFilter('pane', ['pack/anything/new.ts', 'src/FilesPane.tsx']);
    expect(ranked[0].path).toBe('src/FilesPane.tsx');
  });

  it('caps the result list', () => {
    const paths = Array.from({ length: 600 }, (_, i) => `file-${i}.ts`);
    expect(fuzzyFilter('file', paths, 500)).toHaveLength(500);
  });
});
