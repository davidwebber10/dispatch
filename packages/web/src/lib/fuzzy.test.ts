import { describe, it, expect } from 'vitest';
import { fuzzyMatch, fuzzyFilter, fuzzyScore } from './fuzzy';

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

// The command palette's ranking (W1-G, 2026-11-09).
describe('fuzzyScore', () => {
  it('matches a subsequence', () => {
    expect(fuzzyScore('fxl', 'Fix login')).not.toBeNull();
    expect(fuzzyScore('FIX', 'fix login')).not.toBeNull(); // case does not matter
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('ranks a word-start match above a mid-word match', () => {
    const wordStart = fuzzyScore('log', 'Fix login')!;
    const midWord = fuzzyScore('log', 'Catalog sync')!;
    expect(wordStart).toBeGreaterThan(midWord);
  });

  it('ranks adjacent characters above scattered characters', () => {
    const adjacent = fuzzyScore('set', 'Open settings')!;
    const scattered = fuzzyScore('set', 'Some extra text')!;
    expect(adjacent).toBeGreaterThan(scattered);
  });

  it('finds the best placement, not the first one', () => {
    // A greedy match takes the "a" of "Cat" and then cannot be adjacent; the best match is "api".
    expect(fuzzyScore('api', 'Cat pics api')!).toBeGreaterThan(fuzzyScore('api', 'Cat pics a p i')!);
  });

  it('returns null with no match', () => {
    expect(fuzzyScore('xyz', 'Fix login')).toBeNull();
    expect(fuzzyScore('nigol', 'login')).toBeNull(); // the order matters
    expect(fuzzyScore('login page', 'login')).toBeNull(); // a needle longer than the text
  });
});
