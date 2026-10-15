import { render, screen, fireEvent } from '@testing-library/react';
import { test, expect, vi, describe } from 'vitest';
import { AskQuestionCard, AnsweredQuestionCard } from './AskQuestionCard';
import { QUESTION_REPLY_PREFIX, parseQuestionReply } from './questionReply';
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

test('a single single-select question does NOT submit on tap: Submit sends it (answers keyed by question text)', () => {
  const onAnswer = vi.fn();
  const questions: PermissionQuestion[] = [
    { question: 'Which fruit?', header: 'Fruit', options: ['Apple', 'Banana'], multiSelect: false },
  ];
  render(<AskQuestionCard questions={questions} onAnswer={onAnswer} />);
  fireEvent.click(screen.getByRole('button', { name: /Apple/ }));
  expect(onAnswer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /Submit/ }));
  expect(onAnswer).toHaveBeenCalledWith({ 'Which fruit?': 'Apple' });
});

test('Other takes a typed answer, which replaces a single-select pick', () => {
  const onAnswer = vi.fn();
  const questions: PermissionQuestion[] = [{ question: 'Which fruit?', header: 'Fruit', options: ['Apple', 'Banana'] }];
  render(<AskQuestionCard questions={questions} onAnswer={onAnswer} />);
  fireEvent.click(screen.getByRole('button', { name: /Apple/ }));
  fireEvent.click(screen.getByRole('button', { name: /Other/ }));
  const submit = screen.getByRole('button', { name: /Submit/ }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true); // Other chosen but still empty
  fireEvent.change(screen.getByLabelText('Other answer for Fruit'), { target: { value: 'A pear, ripe' } });
  fireEvent.click(submit);
  expect(onAnswer).toHaveBeenCalledWith({ 'Which fruit?': 'A pear, ripe' });
});

test('multi-select plus Other joins the picks and the typed answer with ", "', () => {
  const onAnswer = vi.fn();
  const questions: PermissionQuestion[] = [{ question: 'Toppings?', header: 'Top', options: ['Cheese', 'Onion'], multiSelect: true }];
  render(<AskQuestionCard questions={questions} onAnswer={onAnswer} />);
  fireEvent.click(screen.getByRole('button', { name: /Cheese/ }));
  fireEvent.click(screen.getByRole('button', { name: /Other/ }));
  fireEvent.change(screen.getByLabelText('Other answer for Top'), { target: { value: 'Basil' } });
  fireEvent.click(screen.getByRole('button', { name: /Submit/ }));
  expect(onAnswer).toHaveBeenCalledWith({ 'Toppings?': 'Cheese, Basil' });
});

test('Discuss with text calls onReply; Discuss with nothing typed asks for more context', () => {
  const onReply = vi.fn();
  const onDeny = vi.fn();
  const questions: PermissionQuestion[] = [{ question: 'Which fruit?', options: ['Apple'] }];
  render(<AskQuestionCard questions={questions} onAnswer={() => {}} onReply={onReply} onDeny={onDeny} />);
  fireEvent.click(screen.getByRole('button', { name: 'Discuss' }));
  fireEvent.change(screen.getByLabelText('Discuss the question'), { target: { value: 'Neither, why not C?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(onReply).toHaveBeenCalledWith('Neither, why not C?');
  fireEvent.click(screen.getByRole('button', { name: 'Discuss' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(onDeny).toHaveBeenCalledWith('discuss');
  expect(onReply).toHaveBeenCalledTimes(1);
});

test('Dismiss calls onDeny with dismiss; without handlers, Discuss and Dismiss are hidden', () => {
  const onDeny = vi.fn();
  const questions: PermissionQuestion[] = [{ question: 'Which fruit?', options: ['Apple'] }];
  const { unmount } = render(<AskQuestionCard questions={questions} onAnswer={() => {}} onDeny={onDeny} />);
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(onDeny).toHaveBeenCalledWith('dismiss');
  unmount();
  render(<AskQuestionCard questions={questions} onAnswer={() => {}} />);
  expect(screen.queryByRole('button', { name: 'Discuss' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  expect(screen.getByText('or reply below to discuss')).toBeInTheDocument();
});

test('a Dismiss or empty Discuss locks the card, so a second tap cannot post twice', () => {
  const onDeny = vi.fn();
  const questions: PermissionQuestion[] = [{ question: 'Which fruit?', options: ['Apple'] }];
  render(<AskQuestionCard questions={questions} onAnswer={() => {}} onReply={() => {}} onDeny={onDeny} />);
  const dismiss = screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement;
  fireEvent.click(dismiss);
  fireEvent.click(dismiss);
  expect(onDeny).toHaveBeenCalledTimes(1);
  expect(dismiss.disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Discuss' }) as HTMLButtonElement).disabled).toBe(true);
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

// The tool_result a chat reply produces. Claude Code 2.1.296 (spike, 2026-10-13) returns the
// deny message verbatim as an is_error tool_result. This fixture is that frame's shape and text.
const REPLY_FRAME = {
  type: 'user',
  message: { role: 'user', content: [{
    type: 'tool_result', tool_use_id: 'toolu_01ReplyFixture', is_error: true,
    content: 'The user did not pick an option. They replied: Neither. Why not just use a JSON file instead?\n\n' +
      'Treat this as their answer. If it settles the question, continue. If it pushes back on the options or asks for ' +
      'more context, answer them in plain text and then ask again with revised options. Do not proceed on a guess.',
  }] },
};

describe('AnsweredQuestionCard — a question answered in chat', () => {
  const questions: PermissionQuestion[] = [
    { question: 'Which store?', header: 'Store', options: ['Postgres', 'SQLite'] },
    { question: 'Which cache?', header: 'Cache', options: ['Redis', 'None'] },
  ];
  const resultText = REPLY_FRAME.message.content[0].content;

  test('pins the prefix both sides share', () => {
    expect(QUESTION_REPLY_PREFIX).toBe('The user did not pick an option. They replied: ');
  });

  test('renders "answered in chat" with the reply, not the raw result', () => {
    render(<AnsweredQuestionCard questions={questions} resultText={resultText} />);
    expect(screen.getByRole('button').textContent).toContain('answered in chat: Neither.'); // the one-line summary
    expect(screen.queryByText(/Treat this as their answer/)).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Neither. Why not just use a JSON file instead?')).toBeInTheDocument();
    expect(screen.queryByText(/Treat this as their answer/)).toBeNull(); // no italic raw fallback
    expect(screen.getByText('Which cache?')).toBeInTheDocument();
  });

  test('finds the prefix anywhere in the result (a wrapped message still parses)', () => {
    expect(parseQuestionReply(`<tool_use_error>${resultText}</tool_use_error>`)?.reply)
      .toBe('Neither. Why not just use a JSON file instead?');
  });

  test('drops the attachment note and handles an image-only reply', () => {
    const withImages = 'The user did not pick an option. They replied: Like this\n\n(They also attached 2 images. They follow in the next message.)\n\nTreat this as their answer.';
    expect(parseQuestionReply(withImages)).toEqual({ reply: 'Like this', imageOnly: false });
    expect(parseQuestionReply('The user did not pick an option. They replied with an image only. (1 image. It follows in the next message.)\n\nTreat this.'))
      .toEqual({ reply: '', imageOnly: true });
    expect(parseQuestionReply('Your questions have been answered: "Q"="A".')).toBeNull();
  });
});

// Reported 2026-08-16: an answered card marked only the multi-select answer — every
// single-select whose chosen label contained a comma ("No, visual redesign only") showed
// NO selection, because the parser blind-split answers on ", ".
describe('selectedOptionLabels — comma-bearing labels (regression)', () => {
  it('matches a single-select answer whose label contains a comma', async () => {
    const { selectedOptionLabels } = await import('./AskQuestionCard');
    const labels = ['Yes, live health (Recommended)', 'No, visual redesign only'];
    expect([...(selectedOptionLabels('No, visual redesign only', labels) ?? [])]).toEqual(['No, visual redesign only']);
  });

  it('greedily parses a multi-select join of comma-bearing labels', async () => {
    const { selectedOptionLabels } = await import('./AskQuestionCard');
    const labels = ['Run install button', 'No, skip it', 'Row menu extras'];
    const sel = selectedOptionLabels('No, skip it, Run install button', labels);
    expect(sel && [...sel].sort()).toEqual(['No, skip it', 'Run install button']);
  });

  it('returns null for a free-text Other answer so the card shows it verbatim', async () => {
    const { selectedOptionLabels } = await import('./AskQuestionCard');
    expect(selectedOptionLabels('do something else entirely', ['A', 'B'])).toBeNull();
  });
});
