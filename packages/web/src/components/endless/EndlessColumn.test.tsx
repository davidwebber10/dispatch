import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { EndlessColumn } from './EndlessColumn';
import { ChatMode } from './ChatMode';
import { foldRows } from './EndlessMessageRow';
import { useEndless } from '../../stores/endless';
import { api } from '../../api/client';
import type { EndlessMessage } from '../../api/types';

// Wrap the real scroller hook so a test sees the calls EndlessColumn makes.
const scroller = vi.hoisted(() => ({ toMessage: vi.fn(), toEnd: vi.fn() }));
vi.mock('@shadcn/react/message-scroller', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shadcn/react/message-scroller')>();
  return {
    ...actual,
    useMessageScroller: () => {
      const real = actual.useMessageScroller();
      return {
        ...real,
        scrollToMessage: (id: string, o?: Parameters<typeof real.scrollToMessage>[1]) => { scroller.toMessage(id, o); return real.scrollToMessage(id, o); },
        scrollToEnd: (o?: Parameters<typeof real.scrollToEnd>[0]) => { scroller.toEnd(o); return real.scrollToEnd(o); },
      };
    },
  };
});

beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
});

const msg = (i: number, kind: EndlessMessage['kind'], text: string, over: Partial<EndlessMessage> = {}): EndlessMessage =>
  ({ i, kind, text, size: text.length, project: null, projectName: null, ref: null, media: [], createdAt: 0, ...over });

beforeEach(() => {
  vi.restoreAllMocks();
  scroller.toMessage.mockClear();
  scroller.toEnd.mockClear();
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

  it('a search jump from the tail scrolls to the row through the scroller and does not follow to the end', async () => {
    const page = useEndless.getState().messages;
    vi.spyOn(api, 'endlessMessages').mockResolvedValue({ messages: page, hasMore: true, hasMoreAfter: true });
    render(<EndlessColumn />);
    scroller.toMessage.mockClear();
    scroller.toEnd.mockClear();
    await act(async () => { await useEndless.getState().openAt(5); });
    expect(scroller.toMessage).toHaveBeenCalledTimes(1);
    expect(scroller.toMessage).toHaveBeenCalledWith('m5', { align: 'center' });
    expect(scroller.toEnd).not.toHaveBeenCalled();
  });

  it('scrolls to the focused row once, not on every list change', () => {
    useEndless.setState({ focus: 0 });
    render(<EndlessColumn />);
    expect(scroller.toMessage).toHaveBeenCalledTimes(1);
    expect(scroller.toMessage).toHaveBeenCalledWith('m0', { align: 'center' });
    act(() => { useEndless.setState({ messages: [msg(-1, 'unii', 'older'), ...useEndless.getState().messages] }); });
    expect(scroller.toMessage).toHaveBeenCalledTimes(1);
  });

  it('scrolls to the tool row when the focus is a folded echo', () => {
    useEndless.setState({ focus: 2 });
    render(<EndlessColumn />);
    expect(scroller.toMessage).toHaveBeenCalledTimes(1);
    expect(scroller.toMessage).toHaveBeenCalledWith('m1', { align: 'center' });
  });

  it('when the focus returns to null (Back to latest), scrolls to the end so following resumes', () => {
    useEndless.setState({ focus: 4 });
    render(<EndlessColumn />);
    expect(scroller.toMessage).toHaveBeenCalledWith('m3', { align: 'center' });
    scroller.toEnd.mockClear();
    act(() => { useEndless.setState({ focus: null }); });
    expect(scroller.toEnd).toHaveBeenCalledTimes(1);
  });

  it('does not render undefined when a recall has no id or n', () => {
    useEndless.setState({ messages: [msg(0, 'tool', 'mcp__memory__zoom {}')] });
    render(<EndlessColumn />);
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
    expect(screen.getByText('recalled')).toBeInTheDocument();
  });

  it('keeps the draft when Chat is unavailable and Try again reloads the tail', () => {
    const loadTail = vi.fn().mockResolvedValue(undefined);
    useEndless.setState({ loadTail });
    render(<ChatMode />);
    loadTail.mockClear();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'my draft' } });
    act(() => { useEndless.setState({ unavailable: true }); });
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('my draft');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(loadTail).toHaveBeenCalled();
  });
});
