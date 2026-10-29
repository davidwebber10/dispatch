import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { EndlessColumn } from './EndlessColumn';
import { ChatMode } from './ChatMode';
import { foldRows } from './EndlessMessageRow';
import { useEndless } from '../../stores/endless';
import { useUI } from '../../stores/ui';
import { api } from '../../api/client';
import * as open from './openThread';
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

afterEach(() => { useUI.setState({ view: 'chat', pendingOpenThread: null }); });

beforeEach(() => {
  localStorage.clear(); // drafts persist in local storage; each case starts with none
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
    loaded: true, hasMore: false, atTail: true, focus: null, filter: null, liveText: '', liveThinking: '', turn: { status: 'idle', error: null }, projects: [], pending: [],
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

  it('sends on Enter with no project when none is picked, even under a filter', async () => {
    const send = vi.spyOn(api, 'endlessSend').mockResolvedValue({ ok: true });
    useEndless.setState({ filter: 's1' });
    render(<EndlessColumn />);
    const box = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'hello there' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledWith('hello there', null, [], []));
  });

  it('keeps the draft and shows the error when the send fails, with no unhandled rejection', async () => {
    vi.spyOn(api, 'endlessSend').mockRejectedValue(new Error('POST /api/endless/send failed: 503 Chat is unavailable'));
    const rejections: unknown[] = [];
    const onRejection = (r: unknown) => { rejections.push(r); };
    process.on('unhandledRejection', onRejection);
    try {
      render(<EndlessColumn />);
      const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
      fireEvent.change(box, { target: { value: 'keep me' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(await screen.findByText(/503 Chat is unavailable/)).toBeInTheDocument();
      expect(box.value).toBe('keep me');
      await new Promise((r) => setTimeout(r, 0));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('clears the draft as the send starts, so a slow send cannot leave it behind', async () => {
    let done!: () => void;
    vi.spyOn(api, 'endlessSend').mockImplementation(() => new Promise((r) => { done = () => r({ ok: true }); }));
    render(<EndlessColumn />);
    const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'pending' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(api.endlessSend).toHaveBeenCalled());
    expect(box.value).toBe('');
    await act(async () => { done(); });
    expect(box.value).toBe('');
  });

  it('shows the error when Retry is refused (409), with no unhandled rejection', async () => {
    vi.spyOn(api, 'endlessRetry').mockRejectedValue(new Error('POST /api/endless/retry failed: 409 a turn is running'));
    const rejections: unknown[] = [];
    const onRejection = (r: unknown) => { rejections.push(r); };
    process.on('unhandledRejection', onRejection);
    try {
      useEndless.setState({ turn: { status: 'failed', error: 'rate limited' } });
      render(<EndlessColumn />);
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText(/409 a turn is running/)).toBeInTheDocument();
      await new Promise((r) => setTimeout(r, 0));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
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

  it('a send after an in-tail search jump drops the focus and follows the end', async () => {
    vi.spyOn(api, 'endlessSend').mockResolvedValue({ ok: true });
    useEndless.setState({ focus: 3, atTail: true });
    render(<EndlessColumn />);
    expect(scroller.toMessage).toHaveBeenCalledWith('m3', { align: 'center' });
    scroller.toEnd.mockClear();
    const box = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'follow me' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(scroller.toEnd).toHaveBeenCalled());
    expect(useEndless.getState().focus).toBeNull();
  });

  it('a send with no focus still follows the end (the reader scrolled up)', async () => {
    vi.spyOn(api, 'endlessSend').mockResolvedValue({ ok: true });
    render(<EndlessColumn />);
    scroller.toEnd.mockClear();
    const box = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'hi' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(scroller.toEnd).toHaveBeenCalledTimes(1));
  });

  it('the key is Stop while a turn runs and the draft is empty; a typed draft turns it back to Send', async () => {
    const stop = vi.spyOn(api, 'endlessStop').mockResolvedValue({ ok: true });
    useEndless.setState({ turn: { status: 'running', error: null } });
    render(<EndlessColumn />);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'also this' } });
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('no Stop key when Chat is idle', () => {
    render(<EndlessColumn />);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('shows the error when Stop is refused (409), with no unhandled rejection', async () => {
    vi.spyOn(api, 'endlessStop').mockRejectedValue(new Error('POST /api/endless/stop failed: 409 no turn is running'));
    useEndless.setState({ turn: { status: 'waiting', error: null } });
    render(<EndlessColumn />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText(/Stop failed: .*409/)).toBeInTheDocument();
  });

  it('a sent message shows at once, before the server logs it, and only once after it is logged', async () => {
    vi.spyOn(api, 'endlessSend').mockReturnValue(new Promise(() => {})); // the turn waits for summaries
    render(<EndlessColumn />);
    const box = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'what have i worked on?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    const bubbles = () => screen.queryAllByText('what have i worked on?').filter((el) => el.tagName !== 'TEXTAREA');
    await waitFor(() => expect(bubbles()).toHaveLength(1));
    expect(document.querySelector('[data-pending="true"]')).not.toBeNull();
    act(() => { useEndless.getState().applyEvent({ type: 'endless:message', message: msg(6, 'user', 'what have i worked on?') }); });
    expect(bubbles()).toHaveLength(1);
    expect(document.querySelector('[data-pending="true"]')).toBeNull();
  });

  it('a pending message clears when the turn ends, and a failed send removes it', async () => {
    vi.spyOn(api, 'endlessSend').mockRejectedValueOnce(new Error('POST /api/endless/send failed: 500'));
    render(<EndlessColumn />);
    const box = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'lost one' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await screen.findByText(/Send failed/);
    expect(screen.queryAllByText('lost one').filter((el) => el.tagName !== 'TEXTAREA')).toHaveLength(0);
    act(() => { useEndless.setState({ pending: [{ id: 99, text: 'stale', projectName: null, images: [], files: [] }] }); });
    expect(screen.getByText('stale')).toBeInTheDocument();
    act(() => { useEndless.getState().applyEvent({ type: 'endless:turn', status: 'failed', error: 'x' }); });
    expect(screen.queryByText('stale')).toBeNull();
  });

  it('a turn that failed on the Claude login offers Log in to Claude; another failure does not', () => {
    useEndless.setState({ turn: { status: 'failed', error: 'Failed to authenticate: OAuth session expired and could not be refreshed' } });
    const { unmount } = render(<EndlessColumn />);
    expect(screen.getByRole('button', { name: 'Log in to Claude' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    unmount();
    useEndless.setState({ turn: { status: 'failed', error: 'the turn process exited (code 1) before it finished' } });
    render(<EndlessColumn />);
    expect(screen.queryByRole('button', { name: 'Log in to Claude' })).toBeNull();
  });

  it('does not render undefined when a recall has no id or n', () => {
    useEndless.setState({ messages: [msg(0, 'tool', 'mcp__memory__zoom {}')] });
    render(<EndlessColumn />);
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
    expect(screen.getByText('recalled')).toBeInTheDocument();
  });

  it('Chat shows no project filter bar, on desktop or on the phone, even with projects that have messages', () => {
    vi.spyOn(api, 'endlessMessages').mockResolvedValue({ messages: [], hasMore: false, hasMoreAfter: false });
    useEndless.setState({ projects: [{ id: 's1', name: 'salsify', folder: '/s', live: 0, needsYou: 0, openItems: 0, lastReport: null, messages: 4 }] });
    const { unmount } = render(<ChatMode />);
    expect(screen.queryByRole('toolbar', { name: 'Project filter' })).toBeNull();
    unmount();
    render(<ChatMode mobile />);
    expect(screen.queryByRole('toolbar', { name: 'Project filter' })).toBeNull();
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

  const LONG = 'line one of the report\n' + 'more detail\n'.repeat(30);

  it('a short thread report shows in full, and the card opens its thread', () => {
    useEndless.setState({ messages: [msg(0, 'work', '[Fix login] report: done', { project: 's1', projectName: 'salsify', ref: 't9' })] });
    useUI.setState({ view: 'chat', pendingOpenThread: null });
    render(<EndlessColumn />);
    const spy = vi.spyOn(open, 'openThreadInPlace').mockResolvedValue();
    expect(screen.getByText('[Fix login] report: done')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open thread Fix login' }));
    expect(spy).toHaveBeenCalledWith('s1', 't9');
    expect(useUI.getState().view).toBe('chat');
  });

  it('a long thread report is folded to its name and a preview, and opens on a tap', () => {
    useEndless.setState({ messages: [msg(0, 'work', `[Fix login] report: ${LONG}`, { project: 's1', ref: 't9' })] });
    render(<EndlessColumn />);
    const head = screen.getByRole('button', { name: /Fix login/ });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('Fix login')).toBeTruthy();
    expect(screen.getByText('line one of the report')).toBeTruthy(); // the preview is the first line
    expect(screen.queryAllByText(/more detail/)).toHaveLength(0);
    expect(document.getElementById(head.getAttribute('aria-controls')!)).toBeNull();
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    const body = document.getElementById(head.getAttribute('aria-controls')!)!;
    expect(body.textContent).toContain('more detail');
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryAllByText(/more detail/)).toHaveLength(0);
  });

  it('opening a long thread report scrolls its top into view and does not follow the end', () => {
    useEndless.setState({ messages: [msg(0, 'work', 'short', { project: 's1' }), msg(1, 'work', `[Fix login] report: ${LONG}`, { project: 's1', ref: 't9' })] });
    render(<EndlessColumn />);
    scroller.toMessage.mockClear();
    scroller.toEnd.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Fix login/ }));
    expect(scroller.toMessage).toHaveBeenCalledWith('m1', expect.objectContaining({ align: 'start' }));
    expect(scroller.toEnd).not.toHaveBeenCalled();
  });

  it('closing a long thread report does not scroll', () => {
    useEndless.setState({ messages: [msg(0, 'work', `[Fix login] report: ${LONG}`, { project: 's1', ref: 't9' })] });
    render(<EndlessColumn />);
    const head = screen.getByRole('button', { name: /Fix login/ });
    fireEvent.click(head);
    scroller.toMessage.mockClear();
    fireEvent.click(head);
    expect(scroller.toMessage).not.toHaveBeenCalled();
  });

  it('a thread name that contains a closing bracket still shows as the name', () => {
    useEndless.setState({ messages: [msg(0, 'work', `[[WIP] fold reports] report: ${LONG}`, { project: 's1', ref: 't9' })] });
    render(<EndlessColumn />);
    expect(screen.getByText('[WIP] fold reports')).toBeTruthy();
    expect(screen.getByText('line one of the report')).toBeTruthy();
  });

  it('the Open thread button is a 44px tap target', () => {
    useEndless.setState({ messages: [msg(0, 'work', `[Fix login] report: ${LONG}`, { project: 's1', ref: 't9' })] });
    render(<EndlessColumn />);
    fireEvent.click(screen.getByRole('button', { name: /Fix login/ }));
    expect(screen.getByRole('button', { name: 'Open thread' }).style.minHeight).toBe('44px');
  });

  it('a continuation piece of a split report says it continues', () => {
    useEndless.setState({ messages: [msg(0, 'work', `[Fix login] report: ${LONG}`, { project: 's1', ref: 't9' }), msg(1, 'work', LONG, { project: 's1', ref: 't9' })] });
    render(<EndlessColumn />);
    expect(screen.getByText('Fix login')).toBeTruthy();
    expect(screen.getByText('Thread report (continued)')).toBeTruthy();
  });

  it('an open thread report stays open when a message arrives', () => {
    useEndless.setState({ messages: [msg(0, 'work', `[Fix login] report: ${LONG}`, { project: 's1', ref: 't9' })] });
    render(<EndlessColumn />);
    fireEvent.click(screen.getByRole('button', { name: /Fix login/ }));
    act(() => { useEndless.getState().applyEvent({ type: 'endless:message', message: msg(1, 'unii', 'noted') }); });
    expect(screen.getByRole('button', { name: /Fix login/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('an expanded thread report can open its thread', () => {
    useEndless.setState({ messages: [msg(0, 'work', `[Fix login] report: ${LONG}`, { project: 's1', ref: 't9' })] });
    useUI.setState({ view: 'chat', pendingOpenThread: null });
    render(<EndlessColumn />);
    fireEvent.click(screen.getByRole('button', { name: /Fix login/ }));
    const spy = vi.spyOn(open, 'openThreadInPlace').mockResolvedValue();
    fireEvent.click(screen.getByRole('button', { name: 'Open thread' }));
    expect(spy).toHaveBeenCalledWith('s1', 't9');
  });

  it('user and Dispatch messages are never folded, however long', () => {
    useEndless.setState({ messages: [msg(0, 'user', LONG), msg(1, 'unii', LONG)] });
    render(<EndlessColumn />);
    expect(document.querySelectorAll('[aria-controls]')).toHaveLength(0);
    expect(screen.getAllByText(/more detail/).length).toBeGreaterThan(0);
  });
});
