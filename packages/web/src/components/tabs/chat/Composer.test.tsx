// The thread composer (W1-F): it owns the draft, so a key press renders the composer only and
// never walks the timeline again.
import { Profiler } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { ChatView } from './ChatView';
import { Composer } from './Composer';
import { api } from '../../../api/client';
import * as sock from '../../../api/structured-socket';
import { useTabs } from '../../../stores/tabs';
import type { Terminal } from '../../../api/types';

// Counts every walk of the timeline; the real walk still runs. A plain counter, not vi.fn, so
// vi.restoreAllMocks() below cannot strip the pass-through.
const walks = vi.hoisted(() => ({ n: 0 }));
// Renders of the text box (W1-F); the real PillComposer still renders.
const pill = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../composer/PillComposer', async (orig) => {
  const actual = await orig<typeof import('../../composer/PillComposer')>();
  return { ...actual, PillComposer: (props: any) => { pill.n++; return <actual.PillComposer {...props} />; } };
});
vi.mock('./timeline', async (orig) => {
  const actual = await orig<typeof import('./timeline')>();
  return { ...actual, renderTimeline: (...args: Parameters<typeof actual.renderTimeline>) => { walks.n++; return actual.renderTimeline(...args); } };
});

beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
});

function thread(config: Record<string, unknown> = {}): Terminal {
  return { id: 't1', sessionId: 's1', type: 'claude-code', label: 'T', pid: 1, externalId: 'e', workingDir: '/w', status: 'waiting', createdAt: '', config: { transport: 'structured', ...config }, archivedAt: null, sortOrder: 0 };
}

let onEvent: ((e: any) => void) | undefined;
let send: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();              // drafts persist there
  onEvent = undefined;
  vi.spyOn(sock, 'openStructuredSocket').mockImplementation((h: any) => { onEvent = h.onEvent; return { close: () => {} } as any; });
  send = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(api, 'sendStructuredMessage').mockImplementation(send as never);
  vi.spyOn(api, 'getResumeAdvice').mockResolvedValue({ shouldPrompt: false, ageMinutes: 0, contextTokens: 0 });
  vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as never);
  useTabs.setState({ byProject: { s1: [thread()] } } as never);
});

const box = () => screen.findByPlaceholderText('Message…') as Promise<HTMLTextAreaElement>;

/** Feed `turns` user+assistant pairs through the socket, as a replay does. */
function seedChat(turns: number) {
  act(() => {
    for (let i = 0; i < turns; i++) {
      onEvent!({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: [{ type: 'text', text: `question ${i}` }] } });
      onEvent!({ type: 'assistant', uuid: `a${i}`, message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: `answer ${i} with **markdown** and \`code\`` }] } });
    }
  });
}

describe('typing in the thread composer', () => {
  it('typing does not call renderTimeline', async () => {
    const prof = { commits: 0, ms: 0 };
    render(<Profiler id="chat" onRender={(_i, _p, actual) => { prof.commits++; prof.ms += actual; }}><ChatView terminalId="t1" /></Profiler>);
    const ta = await box();
    seedChat(250);                                         // a 500-item chat
    expect(screen.getByText('question 249')).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 250)); });   // the reveal latch settles
    const before = walks.n; prof.commits = 0; prof.ms = 0;

    let text = '';
    for (let k = 0; k < 20; k++) { text += 'x'; fireEvent.change(ta, { target: { value: text } }); }

    expect(ta.value).toBe('x'.repeat(20));
    const calls = walks.n - before;
    // eslint-disable-next-line no-console
    console.log(`[W1-F perf] chat with 500 items, 20 key presses: renderTimeline calls=${calls}, React commits=${prof.commits}, render time=${prof.ms.toFixed(1)}ms (${(prof.ms / 20).toFixed(2)}ms per key press)`);
    expect(calls).toBe(0);
  });
});

describe('<Composer>', () => {
  const mount = (over: Partial<React.ComponentProps<typeof Composer>> = {}) => {
    const onSend = vi.fn();
    const view = render(<Composer terminalId="t1" sessionId="s1" tab={thread()} busy={false} turnRuns={false} onSend={onSend} {...over} />);
    return { onSend, ...view };
  };

  it('Enter with the send modifier calls onSend and clears the draft', async () => {
    const { onSend } = mount();
    const ta = await box();
    fireEvent.change(ta, { target: { value: 'hello there' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });        // Shift+Enter is a new line
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('hello there');
    expect(ta.value).toBe('');
    expect(localStorage.getItem('dispatch:draft:t1')).toBeNull();
  });

  it('an empty draft sends nothing', async () => {
    const { onSend } = mount();
    const ta = await box();
    fireEvent.change(ta, { target: { value: '   ' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps one draft per thread and shows the right one after an in-place thread switch', async () => {
    const { rerender, onSend } = mount();
    const ta = await box();
    fireEvent.change(ta, { target: { value: 'for thread one' } });
    rerender(<Composer terminalId="t2" sessionId="s1" tab={{ ...thread(), id: 't2' }} busy={false} turnRuns={false} onSend={onSend} />);
    expect((await box()).value).toBe('');
    rerender(<Composer terminalId="t1" sessionId="s1" tab={thread()} busy={false} turnRuns={false} onSend={onSend} />);
    expect((await box()).value).toBe('for thread one');
  });

  it('a turn in flight over an empty composer offers Stop, and typing brings Send back', async () => {
    const interrupt = vi.spyOn(api, 'interrupt').mockResolvedValue(undefined as never);
    mount({ busy: true, turnRuns: true });
    const ta = await box();
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(interrupt).toHaveBeenCalledWith('t1');
    fireEvent.change(ta, { target: { value: 'a follow-up' } });
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull();
  });

  it('a "/" command typed in the box is run by Dispatch and is not sent', async () => {
    const compact = vi.spyOn(api, 'compactTerminal').mockResolvedValue(undefined as never);
    const { onSend } = mount();
    const ta = await box();
    fireEvent.change(ta, { target: { value: '/compact' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    await act(async () => { await Promise.resolve(); });
    expect(compact).toHaveBeenCalledWith('t1');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('renders the footer it is given', async () => {
    mount({ footer: <span>status row</span> });
    await box();
    expect(screen.getByText('status row')).toBeInTheDocument();
  });
});

describe('ChatView and its composer', () => {
  it('a message sent from the composer reaches the thread once, and the box is empty after', async () => {
    render(<ChatView terminalId="t1" />);
    const ta = await box();
    fireEvent.change(ta, { target: { value: 'ship it' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe('t1');
    expect(send.mock.calls[0][1]).toBe('ship it');
    expect(ta.value).toBe('');
  });

  it('a streamed item does not render the text box', async () => {
    render(<ChatView terminalId="t1" />);
    await box();
    seedChat(1);
    await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
    const before = pill.n;
    act(() => {
      for (let i = 0; i < 10; i++) onEvent!({ type: 'assistant', uuid: `s${i}`, message: { id: `sm${i}`, role: 'assistant', content: [{ type: 'text', text: `streamed block ${i}` }] } });
    });
    expect(screen.getByText('streamed block 9')).toBeInTheDocument();
    expect(pill.n).toBe(before);
  });
});
