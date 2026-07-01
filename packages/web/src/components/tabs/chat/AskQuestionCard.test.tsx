import { render, screen, fireEvent } from '@testing-library/react';
import { test, expect, vi } from 'vitest';
import { AskQuestionCard } from './AskQuestionCard';
import type { PermissionQuestion } from '../../../api/types';

test('renders the header, question text, and option labels', () => {
  const questions: PermissionQuestion[] = [
    { question: 'Which fruit?', header: 'Fruit', options: [{ label: 'Apple', description: 'crisp' }, { label: 'Banana' }], multiSelect: false },
  ];
  render(<AskQuestionCard questions={questions} onAnswer={() => {}} />);
  expect(screen.getByText('Fruit')).toBeInTheDocument();
  expect(screen.getByText('Which fruit?')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Apple/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Banana/ })).toBeInTheDocument();
});

test('a single single-select question submits immediately on tap (answers keyed by question text)', () => {
  const onAnswer = vi.fn();
  const questions: PermissionQuestion[] = [
    { question: 'Which fruit?', header: 'Fruit', options: ['Apple', 'Banana'], multiSelect: false },
  ];
  render(<AskQuestionCard questions={questions} onAnswer={onAnswer} />);
  fireEvent.click(screen.getByRole('button', { name: /Apple/ }));
  expect(onAnswer).toHaveBeenCalledWith({ 'Which fruit?': 'Apple' });
});

test('multi-select accumulates picks and joins labels with ", " on Submit', () => {
  const onAnswer = vi.fn();
  const questions: PermissionQuestion[] = [
    { question: 'Which toppings?', header: 'Toppings', options: ['Cheese', 'Mushroom', 'Onion'], multiSelect: true },
  ];
  render(<AskQuestionCard questions={questions} onAnswer={onAnswer} />);
  // No auto-submit for multi-select — tapping toggles.
  fireEvent.click(screen.getByRole('button', { name: /Cheese/ }));
  fireEvent.click(screen.getByRole('button', { name: /Mushroom/ }));
  expect(onAnswer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /Submit/ }));
  expect(onAnswer).toHaveBeenCalledWith({ 'Which toppings?': 'Cheese, Mushroom' });
});

test('multiple questions require an answer for each, then submit one map keyed per question', () => {
  const onAnswer = vi.fn();
  const questions: PermissionQuestion[] = [
    { question: 'Fruit?', options: ['Apple', 'Banana'], multiSelect: false },
    { question: 'Drink?', options: ['Water', 'Juice'], multiSelect: false },
  ];
  render(<AskQuestionCard questions={questions} onAnswer={onAnswer} />);
  // With more than one question there is no auto-submit; the Submit button gates on all answered.
  fireEvent.click(screen.getByRole('button', { name: /Apple/ }));
  expect(onAnswer).not.toHaveBeenCalled();
  const submit = screen.getByRole('button', { name: /Submit/ }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true); // Drink? still unanswered
  fireEvent.click(screen.getByRole('button', { name: /Juice/ }));
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);
  expect(onAnswer).toHaveBeenCalledWith({ 'Fruit?': 'Apple', 'Drink?': 'Juice' });
});
