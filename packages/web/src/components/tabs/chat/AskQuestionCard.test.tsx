import { render, screen, fireEvent } from '@testing-library/react';
import { test, expect, vi, describe } from 'vitest';
import { AskQuestionCard, AnsweredQuestionCard } from './AskQuestionCard';
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

// Regression coverage for the "answering a question makes it vanish" bug: once a question is
// answered, ChatView/Stream render THIS component in its place instead of nothing. `resultText`
// below is the real Claude Code CLI's own AskUserQuestion tool_result template (verified
// against captured session transcripts) — not something Dispatch generates.
describe('AnsweredQuestionCard — the collapsed "answered" record', () => {
  const questions: PermissionQuestion[] = [
    { question: 'Which fruit?', header: 'Fruit', options: [{ label: 'Apple', description: 'crisp' }, { label: 'Banana' }], multiSelect: false },
  ];
  const resultText = 'Your questions have been answered: "Which fruit?"="Apple". You can now continue with these answers in mind.';

  test('collapses to a one-line "Q → A" summary and hides the options until expanded', () => {
    render(<AnsweredQuestionCard questions={questions} resultText={resultText} />);
    expect(screen.getByText(/Which fruit\?/)).toBeInTheDocument();
    expect(screen.getByText(/Apple/)).toBeInTheDocument();
    // Collapsed: the full option list (incl. the unselected "Banana") isn't rendered yet.
    expect(screen.queryByText('Banana')).not.toBeInTheDocument();
    expect(screen.queryByText('crisp')).not.toBeInTheDocument();
  });

  test('expanding reveals the full question, every option, and highlights the one selected', () => {
    render(<AnsweredQuestionCard questions={questions} resultText={resultText} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Fruit')).toBeInTheDocument();
    // The question text is now shown twice: once in the (still-visible) collapsed summary
    // header, once in the expanded body's full question line.
    expect(screen.getAllByText('Which fruit?').length).toBe(2);
    expect(screen.getByText('Apple')).toBeInTheDocument();
    expect(screen.getByText('Banana')).toBeInTheDocument();
    // The selected option's description shows; the unselected one's does not.
    expect(screen.getByText('crisp')).toBeInTheDocument();
  });

  test('a second click re-collapses it', () => {
    render(<AnsweredQuestionCard questions={questions} resultText={resultText} />);
    const toggle = screen.getByRole('button');
    fireEvent.click(toggle);
    expect(screen.getByText('Banana')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByText('Banana')).not.toBeInTheDocument();
  });

  test('multiple questions collapse to the first Q&A plus a "+N more" tally', () => {
    const multi: PermissionQuestion[] = [
      { question: 'Fruit?', options: ['Apple', 'Banana'] },
      { question: 'Drink?', options: ['Water', 'Juice'] },
    ];
    const text = 'Your questions have been answered: "Fruit?"="Apple", "Drink?"="Juice". You can now continue with these answers in mind.';
    render(<AnsweredQuestionCard questions={multi} resultText={text} />);
    expect(screen.getByText(/Fruit\?/)).toBeInTheDocument();
    expect(screen.getByText(/\+1 more/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Drink?')).toBeInTheDocument();
    // Both answers highlighted once expanded.
    const appleRow = screen.getByText('Apple').closest('div');
    const juiceRow = screen.getByText('Juice').closest('div');
    expect(appleRow?.querySelector('svg')).toBeTruthy(); // CheckCircle only renders for the selected row
    expect(juiceRow?.querySelector('svg')).toBeTruthy();
  });

  test('falls back to the raw tool_result text when it does not match the CLI\'s known template', () => {
    const weird = 'some future CLI format we do not understand';
    render(<AnsweredQuestionCard questions={questions} resultText={weird} />);
    // Collapsed summary still shows something useful instead of crashing or showing nothing.
    expect(screen.getByText(/some future CLI format/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    // No option can be matched as "selected", but the raw text is shown as a fallback note.
    expect(screen.getAllByText(/some future CLI format/).length).toBeGreaterThan(0);
  });
});
