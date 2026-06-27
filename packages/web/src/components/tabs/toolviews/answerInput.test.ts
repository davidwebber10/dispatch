import { test, expect } from 'vitest';
import { buildAnswerInput, parseQuestions } from './answerInput';

const DOWN = '\x1b[B', ENTER = '\r', SPACE = ' ';

test('single-select first option is just Enter', () => {
  const q = [{ question: 'q', options: [{ label: 'a' }, { label: 'b' }] }];
  expect(buildAnswerInput(q, [[0]])).toBe(ENTER);
});

test('single-select third option moves down twice then Enter', () => {
  const q = [{ question: 'q', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }];
  expect(buildAnswerInput(q, [[2]])).toBe(DOWN + DOWN + ENTER);
});

test('two questions answer in order', () => {
  const q = [
    { question: 'q1', options: [{ label: 'a' }, { label: 'b' }] },
    { question: 'q2', options: [{ label: 'c' }, { label: 'd' }] },
  ];
  expect(buildAnswerInput(q, [[1], [0]])).toBe(DOWN + ENTER + ENTER);
});

test('multiSelect toggles selected options with Space while walking down', () => {
  const q = [{ question: 'q', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }];
  // select indices 0 and 2: SPACE, DOWN, DOWN, SPACE, ENTER
  expect(buildAnswerInput(q, [[0, 2]])).toBe(SPACE + DOWN + DOWN + SPACE + ENTER);
});

test('multiSelect single middle option', () => {
  const q = [{ question: 'q', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] }];
  expect(buildAnswerInput(q, [[1]])).toBe(DOWN + SPACE + ENTER);
});

test('parseQuestions reads the questions array, tolerating junk', () => {
  const input = JSON.stringify({ questions: [{ question: 'q', header: 'H', multiSelect: false, options: [{ label: 'a', description: 'd' }] }] });
  expect(parseQuestions(input)).toEqual([{ question: 'q', header: 'H', multiSelect: false, options: [{ label: 'a', description: 'd' }] }]);
  expect(parseQuestions('not json')).toEqual([]);
  expect(parseQuestions(undefined)).toEqual([]);
  expect(parseQuestions('{"questions":"nope"}')).toEqual([]);
});
