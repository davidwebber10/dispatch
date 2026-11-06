import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { WorkingIndicator } from './WorkingIndicator';
import { useSpinnerWords } from '../stores/spinnerWords';

afterEach(() => { cleanup(); useSpinnerWords.setState({ verbs: null }); });

test('says Working… until words are chosen', () => {
  render(<WorkingIndicator />);
  expect(screen.getByText('Working…')).toBeInTheDocument();
});

test('uses one of your words, from Settings', () => {
  useSpinnerWords.setState({ verbs: { mode: 'replace', verbs: ['Tinkering'] } });
  render(<WorkingIndicator />);
  expect(screen.getByText('Tinkering…')).toBeInTheDocument();
});
