import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { test, expect, describe, it, beforeAll, beforeEach, vi } from 'vitest';
import { MessageScroller } from '@shadcn/react/message-scroller';
import type { ConvItem } from '../../../api/types';
import { UserBubble, renderTimeline, LoadEarlierButton, ChatView } from './ChatView';
import { api } from '../../../api/client';
import * as sock from '../../../api/structured-socket';

test('a human-sent turn (untagged/legacy or explicit "user") renders as a plain bubble with no "via" label', () => {
  render(<UserBubble text="hi claude" />);
  expect(screen.getByText('hi claude')).toBeInTheDocument();
  expect(screen.queryByText(/^via /)).not.toBeInTheDocument();
});

test('an explicit source="user" turn also renders with no "via" label', () => {
  render(<UserBubble text="hi claude" source="user" />);
  expect(screen.getByText('hi claude')).toBeInTheDocument();
  expect(screen.queryByText(/^via /)).not.toBeInTheDocument();
});

test('a coordinator-relayed turn (source="coordinator") gets a "via {coordinator name}" label', () => {
  render(<UserBubble text="do the thing" source="coordinator" />);
  expect(screen.getByText('do the thing')).toBeInTheDocument();
  // Default coordinatorName is '' → useDispatchName falls back to "Control Plane".
  expect(screen.getByText(/via Control Plane/)).toBeInTheDocument();
});

// jsdom lacks the observers the MessageScroller primitive touches (mirrors Stream.test.tsx).
beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
});

// A full <ChatView> render (below) opens a live ws on mount via useStructuredChat — stub it
// out (mirrors MobileApp.test.tsx's own ChatView-mounting setup) so tests don't depend on a
// real socket. restoreAllMocks first so a spy from one test never leaks into the next.
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(sock, 'openStructuredSocket').mockImplementation(() => ({ close: () => {} }) as any);
});

function renderTimelineItems(items: ConvItem[]) {
  return render(
    <MessageScroller.Provider>
      <MessageScroller.Root>
        <MessageScroller.Viewport>
          <MessageScroller.Content>
            {renderTimeline(items, () => {}, new Set())}
          </MessageScroller.Content>
        </MessageScroller.Viewport>
      </MessageScroller.Root>
    </MessageScroller.Provider>,
  );
}

// Regression coverage for the reported bug: a subagent's answered AskUserQuestion used to
// vanish from the chat entirely once answered — renderTimeline unconditionally `continue`d
// past ANY item named 'AskUserQuestion' (live or answered alike), relying solely on the
// interactive <AskQuestionCard> overlay (ChatView's `pending` prop) to ever show it, which
// unmounts the instant it's answered. Now an answered pair renders a durable, collapsed record.
describe('renderTimeline — answered AskUserQuestion stays in history (regression)', () => {
  const items: ConvItem[] = [
    { kind: 'tool', toolId: 'tu-1', toolName: 'AskUserQuestion', toolInput: JSON.stringify({ questions: [{ question: 'Ready to ship?', header: 'Release', options: ['Yes', 'No'] }] }) },
    { kind: 'tool-result', toolId: 'tu-1', text: 'Your questions have been answered: "Ready to ship?"="Yes". You can now continue with these answers in mind.' },
  ];

  it('shows a collapsed "Q → A" summary instead of nothing', () => {
    renderTimelineItems(items);
    expect(screen.getByText(/Ready to ship\?/)).toBeInTheDocument();
    expect(screen.getByText(/Yes/)).toBeInTheDocument();
    expect(screen.queryByText('No')).not.toBeInTheDocument(); // collapsed: options aren't shown yet
  });

  it('expanding it reveals the full question, every option, and which one was picked', () => {
    renderTimelineItems(items);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Release')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument(); // the unpicked option, now visible
  });

  it('renders nothing while genuinely still pending (no tool_result yet) — the live overlay covers it', () => {
    const pendingOnly: ConvItem[] = [
      { kind: 'tool', toolId: 'tu-2', toolName: 'AskUserQuestion', toolInput: JSON.stringify({ questions: [{ question: 'Which env?', options: ['staging', 'prod'] }] }) },
    ];
    renderTimelineItems(pendingOnly);
    expect(screen.queryByText('Which env?')).not.toBeInTheDocument();
  });

  it('pairs tool_use ↔ tool_result via array adjacency too (older REST-paged history has no toolId)', () => {
    const noToolId: ConvItem[] = [
      { kind: 'tool', toolName: 'AskUserQuestion', toolInput: JSON.stringify({ questions: [{ question: 'Cut the release?', options: ['Yes', 'No'] }] }) },
      { kind: 'tool-result', text: 'Your questions have been answered: "Cut the release?"="Yes". You can now continue with these answers in mind.' },
    ];
    renderTimelineItems(noToolId);
    expect(screen.getByText(/Cut the release\?/)).toBeInTheDocument();
  });
});

// Regression coverage for the reported bug: expanding a tool call while its subagent is
// still actively streaming used to auto-collapse ~a second later. Root cause — a live
// content_block_start appends a NEW item to `items` for every block within the SAME
// still-open assistant turn (see useStructuredChat's stream_event handler), and
// renderTimeline re-anchors the enclosing turn's MessageScroller.Item `key` to whichever
// item is now LAST in the group on every such append. A changed `key` forces React to
// unmount + remount the whole turn subtree, wiping ToolCall's local `useState` expand flag.
// This simulates exactly that: expand a tool call, then rerender with a new tool item
// appended to the same (still-open) turn, and assert the expansion survives.
describe('renderTimeline — an expanded tool call survives a live streaming re-render (regression)', () => {
  it('stays expanded when a new item is appended to the same turn', () => {
    const toolA: ConvItem = { kind: 'tool', toolId: 'tu-a', toolName: 'Bash', toolTitle: 'Bash', toolInput: 'ls -la' };
    const resultA: ConvItem = { kind: 'tool-result', toolId: 'tu-a', text: 'file1\nfile2' };
    const { rerender } = render(
      <MessageScroller.Provider>
        <MessageScroller.Root>
          <MessageScroller.Viewport>
            <MessageScroller.Content>
              {renderTimeline([toolA, resultA], () => {}, new Set())}
            </MessageScroller.Content>
          </MessageScroller.Viewport>
        </MessageScroller.Root>
      </MessageScroller.Provider>,
    );

    fireEvent.click(screen.getByText('Bash'));
    expect(screen.getByText('Output')).toBeInTheDocument(); // expanded: tab strip visible

    // A new content block starts elsewhere in the SAME (still-open) assistant turn —
    // e.g. the subagent kicks off a second tool call before finishing its reply.
    const toolB: ConvItem = { kind: 'tool', toolId: 'tu-b', toolName: 'Read', toolTitle: 'Read', toolInput: 'file.txt' };
    rerender(
      <MessageScroller.Provider>
        <MessageScroller.Root>
          <MessageScroller.Viewport>
            <MessageScroller.Content>
              {renderTimeline([toolA, resultA, toolB], () => {}, new Set())}
            </MessageScroller.Content>
          </MessageScroller.Viewport>
        </MessageScroller.Root>
      </MessageScroller.Provider>,
    );

    expect(screen.getByText('Output')).toBeInTheDocument(); // still expanded, not auto-collapsed
  });
});

// ---- "Load earlier messages" escape hatch -------------------------------------------
// Paging older history used to depend ENTIRELY on the reader being able to scroll (the
// near-top viewport trigger, or useBootstrapOlderPages' overflow check). A window short
// enough not to overflow — in the limit, an empty one — left `hasMore: true` history with
// no way to reach it. This control makes it reachable unconditionally.
describe('LoadEarlierButton', () => {
  it('renders when there is more history to load and calls loadOlder when clicked', () => {
    const loadOlder = vi.fn();
    render(<LoadEarlierButton show onClick={loadOlder} />);
    const btn = screen.getByRole('button', { name: 'Load earlier messages' });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while a fetch is in flight (the floating pill owns that state)', () => {
    const { container } = render(<LoadEarlierButton show={false} onClick={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

// ---- Resume-from-summary advice (Pretty threads spawn with -p, so Claude Code's own
// interactive "resume from summary?" dialog never renders — this is that choice's web
// equivalent). ------------------------------------------------------------------------
describe('ChatView — resume-from-summary advice', () => {
  it('offers the resume choice for an old, large thread and compacts on accept', async () => {
    vi.spyOn(api, 'getResumeAdvice').mockResolvedValue({ shouldPrompt: true, ageMinutes: 4560, contextTokens: 134_000 });
    const compactTerminal = vi.spyOn(api, 'compactTerminal').mockResolvedValue(undefined as never);
    render(<ChatView terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: /resume from summary/i }));
    expect(compactTerminal).toHaveBeenCalledWith('t1');
    await waitFor(() => expect(screen.queryByRole('button', { name: /resume from summary/i })).toBeNull());
  });

  it('does not offer the resume choice when the daemon says not to', async () => {
    vi.spyOn(api, 'getResumeAdvice').mockResolvedValue({ shouldPrompt: false, ageMinutes: 0, contextTokens: 0 });
    render(<ChatView terminalId="t1" />);
    await waitFor(() => expect(screen.queryByRole('button', { name: /resume from summary/i })).toBeNull());
  });

  // Regression guard: onSummarize must call api.compactTerminal DIRECTLY, not
  // useStructuredChat's compact() (which is fire-and-forget — `.catch(() => {})` — and would
  // silently swallow the 409 the endpoint returns when no live structured session backs the
  // thread). On the RESOLVE path the two are indistinguishable, so this only has teeth on
  // the reject path: a failed summarization must surface a visible error line, not look
  // like it quietly succeeded.
  it('surfaces a visible error when compactTerminal rejects (no live structured session)', async () => {
    vi.spyOn(api, 'getResumeAdvice').mockResolvedValue({ shouldPrompt: true, ageMinutes: 4560, contextTokens: 134_000 });
    vi.spyOn(api, 'compactTerminal').mockRejectedValue(new Error('No live structured session to compact'));
    render(<ChatView terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: /resume from summary/i }));
    expect(await screen.findByText(/No live structured session to compact/)).toBeInTheDocument();
  });

  // Regression guard: PaneTree/PaneFrame render <TabHost terminalId={tabId}/> with no `key`,
  // so reassigning a pane's tab updates terminalId on the SAME ChatView instance rather than
  // remounting it. The advice effect's `cancelled` closure flag correctly guards against an
  // in-flight response from the OLD terminalId landing late, but it never cleared previously
  // -resolved state — so switching in place from a thread that showed the card to one that
  // shouldn't left the old thread's stale card (its age/token numbers) rendering under the
  // new thread's identity. Uses `rerender` (not a fresh render) so the same component
  // instance is reused, actually exercising the in-place-switch path.
  it('clears a stale card from the previous thread when switching terminalId in place', async () => {
    vi.spyOn(api, 'getResumeAdvice').mockImplementation(async (id: string) =>
      id === 't1'
        ? { shouldPrompt: true, ageMinutes: 4560, contextTokens: 134_000 }
        : { shouldPrompt: false, ageMinutes: 0, contextTokens: 0 },
    );
    const { rerender } = render(<ChatView terminalId="t1" />);
    expect(await screen.findByRole('button', { name: /resume from summary/i })).toBeInTheDocument();

    rerender(<ChatView terminalId="t2" />);
    await waitFor(() => expect(screen.queryByRole('button', { name: /resume from summary/i })).toBeNull());
  });
});
