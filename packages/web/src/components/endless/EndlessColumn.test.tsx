import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EndlessColumn } from './EndlessColumn';
import { foldRows } from './EndlessMessageRow';
import { useEndless } from '../../stores/endless';
import { api } from '../../api/client';
import type { EndlessMessage } from '../../api/types';

beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
});

const msg = (i: number, kind: EndlessMessage['kind'], text: string, over: Partial<EndlessMessage> = {}): EndlessMessage =>
  ({ i, kind, text, size: text.length, project: null, projectName: null, ref: null, media: [], createdAt: 0, ...over });

beforeEach(() => {
  vi.restoreAllMocks();
  useEndless.setState({
    messages: [
      msg(0, 'user', 'check the exporter', { project: 's1', projectName: 'salsify' }),
      msg(1, 'tool', 'Bash {"command":"ls"}'),
      msg(2, 'echo', 'a.txt'),
      msg(3, 'tool', 'mcp__memory__zoom {"id":32,"n":16}'),
      msg(4, 'echo', '32+8|x'),
      msg(5, 'unii', 'The exporter is fine.'),
    ],
    loaded: true, hasMore: false, atTail: true, focus: null, filter: null, liveText: '', liveThinking: '', turn: { status: 'idle', error: null }, projects: [],
  });
});

describe('EndlessColumn', () => {
  it('folds a tool call and its result into one row and marks a zoom as recalled', () => {
    const rows = foldRows(useEndless.getState().messages);
    expect(rows.map((r) => r.kind)).toEqual(['msg', 'tool', 'recall', 'msg']);
  });

  it('renders the user bubble with its project, the reply, one tool line, and the recalled line', () => {
    render(<EndlessColumn />);
    expect(screen.getByText('check the exporter')).toBeInTheDocument();
    expect(screen.getByText('salsify')).toBeInTheDocument();
    expect(screen.getByText('The exporter is fine.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Bash/ })).toBeInTheDocument();
    expect(screen.getByText('recalled 32+16')).toBeInTheDocument();
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Bash/ }));
    expect(screen.getByText(/a\.txt/)).toBeInTheDocument();
  });

  it('shows live thinking and text while a turn runs', () => {
    useEndless.setState({ turn: { status: 'running', error: null }, liveThinking: 'weighing options', liveText: 'Partial answer' });
    render(<EndlessColumn />);
    expect(screen.getByText('weighing options')).toBeInTheDocument();
    expect(screen.getByText('Partial answer')).toBeInTheDocument();
  });

  it('shows the error and a Retry button when a turn failed', async () => {
    const retry = vi.spyOn(api, 'endlessRetry').mockResolvedValue({ ok: true });
    useEndless.setState({ turn: { status: 'failed', error: 'rate limited' } });
    render(<EndlessColumn />);
    expect(screen.getByText(/rate limited/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(retry).toHaveBeenCalled());
  });

  it('sends on Enter with the active filter as the project', async () => {
    const send = vi.spyOn(api, 'endlessSend').mockResolvedValue({ ok: true });
    useEndless.setState({ filter: 's1' });
    render(<EndlessColumn />);
    const box = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'hello there' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledWith('hello there', 's1', []));
  });
});
