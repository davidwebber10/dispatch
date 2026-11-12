// The OS look (askLook.tsx): the business preview (an explicit opt-in) keeps the Pretty structure and
// takes the OS type and input style; a local install AND a hosted box keep the Dispatch look exactly.
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { setHostContextForTest } from '../../../lib/hostContext';
import type { ConvItem } from '../../../api/types';
import { ToolCall, readableToolName } from '../ToolCall';
import { UserBubble } from './timeline/leaves';
import { PillComposer } from '../../composer/PillComposer';
import { askLook } from './askLook';

const dictation = { state: 'idle', error: null, recordingId: null, start: async () => {}, stop: () => {}, cancel: () => {}, retry: async () => {}, reset: () => {}, insert: () => {} } as never;
const tool: ConvItem = { kind: 'tool', toolId: 't1', toolName: 'mcp__shopify__get_order', toolInput: '{"order_id":"PW1"}' } as ConvItem;
const result: ConvItem = { kind: 'tool-result', toolId: 't1', text: 'line 1\nline 2' } as ConvItem;
const composer = (look?: 'os') => <PillComposer look={look} value="" onChange={() => {}} onSend={() => {}} canSend={false} placeholder="Message…" onAddFile={() => {}} dictation={dictation} sttConfigured />;

afterEach(() => { cleanup(); setHostContextForTest({}); });

describe('the OS look of the Pretty thread', () => {
  it('is off on a local install and on a hosted box; on only for the business preview', () => {
    setHostContextForTest({});
    expect(askLook()).toBe(false);
    setHostContextForTest({ hosted: true });
    expect(askLook()).toBe(false);
    setHostContextForTest({ hosted: true, profile: 'business' });
    expect(askLook()).toBe(false);
    setHostContextForTest({}, true);
    expect(askLook()).toBe(true);
  });

  it('local: the tool row, the bubble and the composer stay as they were', () => {
    setHostContextForTest({});
    render(<ToolCall tool={tool} result={result} />);
    const name = screen.getByText('mcp__shopify__get_order');
    expect(name.style.font).toContain('var(--font-mono)');
    expect(screen.getByText('2 lines')).toBeTruthy();
    cleanup();
    render(<UserBubble text="hello" />);
    expect(screen.getByText('YOU')).toBeTruthy();
    expect(screen.getByTestId('user-bubble').style.borderRadius).toBe('var(--radius-md)');
    cleanup();
    render(composer());
    const box = screen.getByTestId('pill-composer');
    expect(box.style.borderRadius).toBe('var(--radius-xl)');
    expect(box.getAttribute('data-look')).toBeNull();
  });

  it('hosted developer: the same Pretty row with the raw name, and the JSON expander still opens', () => {
    setHostContextForTest({ hosted: true });
    render(<ToolCall tool={tool} result={result} />);
    fireEvent.click(screen.getByText('mcp__shopify__get_order'));
    expect(screen.getByRole('button', { name: 'Input' })).toBeTruthy();
    expect(screen.getByText(/line 1/)).toBeTruthy();
  });

  it('business preview: a plain one-line label in OS type, no JSON expander', () => {
    setHostContextForTest({}, true);
    render(<ToolCall tool={tool} result={result} />);
    const name = screen.getByText('get order');
    expect(name.style.font).toContain('var(--font-sans)');
    expect(screen.getByText('order_id: PW1')).toBeTruthy();
    fireEvent.click(name);
    expect(screen.queryByRole('button', { name: 'Input' })).toBeNull();
  });

  it('business preview: the bubble keeps its label and takes OS type; the composer is an OS input', () => {
    setHostContextForTest({}, true);
    render(<UserBubble text="hello" />);
    expect(screen.getByText('YOU')).toBeTruthy();
    const b = screen.getByTestId('user-bubble');
    expect(b.style.borderRadius).toBe('var(--radius-lg)');
    expect(b.style.font).toContain('14px');
    cleanup();
    render(composer('os'));
    const box = screen.getByTestId('pill-composer');
    expect(box.style.borderRadius).toBe('var(--radius-lg)');
    expect(box.style.border).toContain('var(--color-border-hover)');
    expect(screen.getByRole('button', { name: 'Send' }).style.opacity).toBe('0.5');
  });

  it('readableToolName strips the MCP prefix only', () => {
    expect(readableToolName('mcp__claude_ai_Gmail__send_message')).toBe('send message');
    expect(readableToolName('Read')).toBe('Read');
  });
});
