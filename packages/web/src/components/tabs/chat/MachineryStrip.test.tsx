import { expect, test, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MachineryStrip } from './MachineryStrip';
import type { ConvItem } from '../../../api/types';

afterEach(cleanup);

const tool = (id: string, name: string, input: Record<string, unknown> = {}): ConvItem =>
  ({ kind: 'tool', toolId: id, toolName: name, toolInput: JSON.stringify(input) }) as ConvItem;
const res = (id: string, text = 'ok'): ConvItem => ({ kind: 'tool-result', toolId: id, text }) as ConvItem;

test('a single tool renders one ToolCall row with its name', () => {
  render(<MachineryStrip items={[tool('b1', 'Bash', { command: 'ls' }), res('b1')]} />);
  expect(screen.getByText('Bash')).toBeInTheDocument();
});

test('a run of same-tool calls collapses into one ToolGroup header (×N)', () => {
  render(<MachineryStrip items={[
    tool('r1', 'Read', { file_path: '/a.ts' }), res('r1'),
    tool('r2', 'Read', { file_path: '/b.ts' }), res('r2'),
    tool('r3', 'Read', { file_path: '/c.ts' }), res('r3'),
  ]} />);
  expect(screen.getByText('×3')).toBeInTheDocument();
  expect(screen.getByText('Read')).toBeInTheDocument(); // one header, not three rows
});

test('the batched [T,T,R,R] shape (parallel same-tool calls) still pairs and groups', () => {
  render(<MachineryStrip items={[
    tool('r1', 'Read', { file_path: '/a.ts' }),
    tool('r2', 'Read', { file_path: '/b.ts' }),
    res('r1'), res('r2'),
  ]} />);
  expect(screen.getByText('×2')).toBeInTheDocument();
});

test('an orphan tool-result (its tool fell outside the window) renders standalone, not dropped', () => {
  render(<MachineryStrip items={[res('gone', 'line1\nline2')]} />);
  expect(screen.getByText(/Output/)).toBeInTheDocument();
});

test('different tools stay separate rows in one strip', () => {
  render(<MachineryStrip items={[tool('b1', 'Bash', { command: 'ls' }), res('b1'), tool('g1', 'Grep', { pattern: 'x' }), res('g1')]} />);
  expect(screen.getByText('Bash')).toBeInTheDocument();
  expect(screen.getByText('Grep')).toBeInTheDocument();
});
