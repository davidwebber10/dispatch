import { render, screen, fireEvent, act } from '@testing-library/react';
import { vi, test, expect, afterEach } from 'vitest';
import { AskQuestionView } from './AskQuestionView';
import { api } from '../../../api/client';
import { useQuestionAnswers } from '../../../stores/questionAnswers';

const tool = {
  kind: 'tool', toolName: 'AskUserQuestion', uuid: 'u1',
  toolInput: JSON.stringify({ questions: [
    { question: 'Which approach?', header: 'Approach', multiSelect: false, options: [
      { label: 'Option A', description: 'first' }, { label: 'Option B', description: 'second' },
    ] },
  ] }),
} as any;

afterEach(() => { vi.restoreAllMocks(); useQuestionAnswers.setState({ byUuid: {} }); });

test('renders the question, header chip, and options', () => {
  render(<AskQuestionView tool={tool} answerable={false} terminalId="t1" onAnswerInTerminal={() => {}} />);
  expect(screen.getByText('Which approach?')).toBeInTheDocument();
  expect(screen.getByText('Approach')).toBeInTheDocument();
  expect(screen.getByText('Option A')).toBeInTheDocument();
  expect(screen.getByText('Option B')).toBeInTheDocument();
});

test('clicking a single-select option submits keystrokes for that option', () => {
  useQuestionAnswers.setState({ byUuid: {} });
  const spy = vi.spyOn(api, 'sendInput').mockResolvedValue(undefined as any);
  render(<AskQuestionView tool={tool} answerable={true} terminalId="t1" onAnswerInTerminal={() => {}} />);
  fireEvent.click(screen.getByText('Option B')); // index 1 → DOWN + ENTER
  expect(spy).toHaveBeenCalledWith('t1', '\x1b[B\r');
});

test('not answerable: clicking does not send input', () => {
  const spy = vi.spyOn(api, 'sendInput').mockResolvedValue(undefined as any);
  render(<AskQuestionView tool={tool} answerable={false} terminalId="t1" onAnswerInTerminal={() => {}} />);
  fireEvent.click(screen.getByText('Option A'));
  expect(spy).not.toHaveBeenCalled();
});

test('after submit with no result within 6s, shows an Answer in Terminal action', () => {
  vi.useFakeTimers();
  useQuestionAnswers.setState({ byUuid: {} });
  vi.spyOn(api, 'sendInput').mockResolvedValue(undefined as any);
  const onTerm = vi.fn();
  render(<AskQuestionView tool={tool} answerable={true} terminalId="t1" onAnswerInTerminal={onTerm} />);
  fireEvent.click(screen.getByText('Option A'));
  act(() => { vi.advanceTimersByTime(6100); });
  fireEvent.click(screen.getByText(/Answer in Terminal/));
  expect(onTerm).toHaveBeenCalled();
  vi.useRealTimers();
});
