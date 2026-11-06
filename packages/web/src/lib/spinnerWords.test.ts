import { expect, test } from 'vitest';
import { DEFAULT_WORD, parseWords, pickWord, wordPool, WORD_SETS } from './spinnerWords';

test('no words chosen: the indicator says Working', () => {
  expect(wordPool(null)).toEqual([DEFAULT_WORD]);
  expect(pickWord(undefined)).toBe('Working');
});

test('"Only mine" uses only your words; "Add to Claude\'s" keeps Working among them', () => {
  expect(wordPool({ mode: 'replace', verbs: ['Shipping', 'Tinkering'] })).toEqual(['Shipping', 'Tinkering']);
  expect(wordPool({ mode: 'append', verbs: ['Shipping'] })).toEqual(['Working', 'Shipping']);
  expect(pickWord({ mode: 'replace', verbs: ['A', 'B', 'C'] }, () => 0.99)).toBe('C');
  expect(pickWord({ mode: 'replace', verbs: ['A', 'B', 'C'] }, () => 0)).toBe('A');
});

test('a typed list: commas or lines, trimmed, no trailing dots, no repeats', () => {
  expect(parseWords(' Shipping…, tinkering\nShipping ,, On it... ')).toEqual(['Shipping', 'tinkering', 'On it']);
});

test('every built-in set has words', () => {
  for (const s of WORD_SETS) expect(s.words.length).toBeGreaterThan(3);
});
