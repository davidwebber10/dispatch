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

function renderTimelineItems(items: ConvItem[], pageBoundaries: Set<ConvItem> = new Set()) {
  return render(
    <MessageScroller.Provider>
      <MessageScroller.Root>
        <MessageScroller.Viewport>
          <MessageScroller.Content>
            {renderTimeline(items, () => {}, pageBoundaries)}
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

// ---- Grouping a run of consecutive same-tool calls into one collapsible row ----------
// Six Reads in a turn would otherwise be six separate rows that bury the assistant's
// prose (see ChatView's ToolGroup doc comment). A run of 2+ same-tool calls collapses;
// a lone call or a run broken by a different tool / a page boundary does not.
describe('renderTimeline — groups a run of consecutive same-tool calls', () => {
  const read = (id: string, file: string, lines: number) => [
    { kind: 'tool', toolId: id, toolName: 'Read', toolTitle: `Read ${file}`, toolDetail: file, toolInput: '{}' },
    { kind: 'tool-result', toolId: id, text: Array(lines).fill('x').join('\n') },
  ] as ConvItem[];

  it('collapses a run of same-tool calls into one row', () => {
    const items = [...read('a', 'one.ts', 3), ...read('b', 'two.ts', 3), ...read('c', 'three.ts', 3)];
    renderTimelineItems(items);
    expect(screen.getByText('Read 3 files')).toBeTruthy();
    expect(screen.queryByText('one.ts')).toBeNull();
  });

  it('expands the group to the individual calls', () => {
    const items = [...read('a', 'one.ts', 3), ...read('b', 'two.ts', 3), ...read('c', 'three.ts', 3)];
    renderTimelineItems(items);
    fireEvent.click(screen.getByText('Read 3 files'));
    expect(screen.getByText('one.ts')).toBeTruthy();
    expect(screen.getByText('three.ts')).toBeTruthy();
  });

  it('does not group different tools, and lets a later run of the original tool start fresh', () => {
    // Read,Read,Bash,Read,Read — a different tool in the middle must both break the first
    // run AND not prevent a second run from forming afterward.
    const bash = [
      { kind: 'tool', toolId: 'x', toolName: 'Bash', toolTitle: 'Bash', toolDetail: 'ls' },
      { kind: 'tool-result', toolId: 'x', text: 'file1\nfile2' },
    ] as ConvItem[];
    const items = [...read('a', 'one.ts', 3), ...read('b', 'two.ts', 3), ...bash, ...read('c', 'three.ts', 3), ...read('d', 'four.ts', 3)];
    renderTimelineItems(items);
    expect(screen.getAllByText('Read 2 files')).toHaveLength(2); // two separate groups, not one run of 4
    expect(screen.queryByText(/Bash \d (files|calls)/)).toBeNull(); // the lone Bash never groups
  });

  it('does not group a lone tool call', () => {
    renderTimelineItems(read('a', 'one.ts', 3));
    expect(screen.queryByText(/Read \d files/)).toBeNull();
    expect(screen.getByText('one.ts')).toBeTruthy();
  });

  it('breaks a group at a page boundary so prepends cannot merge into it', () => {
    const items = [...read('a', 'one.ts', 3), ...read('b', 'two.ts', 3)];
    renderTimelineItems(items, new Set([items[2]]));
    expect(screen.queryByText(/Read \d files/)).toBeNull();
  });

  // The case above lands the boundary on a `tool` item — the one case that cannot fail,
  // since the look-ahead's tool-result handling only ever runs for a `tool-result` item.
  // Pages are cut at arbitrary JSONL offsets, so the oldest rendered item is frequently an
  // ORPHAN tool-result instead (its own tool_use fell outside the replay window) — that
  // must break the run too, not be silently swallowed by the paired-result skip.
  it('breaks a group at a page boundary that lands on a tool-result, not just a tool', () => {
    const items = [...read('a', 'one.ts', 3), ...read('b', 'two.ts', 3)];
    renderTimelineItems(items, new Set([items[1]])); // boundary is the tool-result of run 'a'
    expect(screen.queryByText(/Read \d files/)).toBeNull();
  });

  it('renders a group expanded while a member is still running', () => {
    const items = [...read('a', 'one.ts', 3), { kind: 'tool', toolId: 'b', toolName: 'Read', toolTitle: 'Read two.ts', toolDetail: 'two.ts' } as ConvItem];
    renderTimelineItems(items);
    expect(screen.getByText('one.ts')).toBeTruthy();
    expect(screen.getByText('two.ts')).toBeTruthy();
  });

  // Invariant 3: AskUserQuestion always has its own live-overlay special-casing and must
  // never collapse into a group, even when several answered ones sit back to back.
  it('never groups AskUserQuestion, even when several appear consecutively', () => {
    const q = (id: string, question: string, answer: string) => [
      { kind: 'tool', toolId: id, toolName: 'AskUserQuestion', toolInput: JSON.stringify({ questions: [{ question, options: ['Yes', 'No'] }] }) },
      { kind: 'tool-result', toolId: id, text: `Your questions have been answered: "${question}"="${answer}". You can now continue with these answers in mind.` },
    ] as ConvItem[];
    const items = [...q('q1', 'Ship it?', 'Yes'), ...q('q2', 'Deploy now?', 'No')];
    renderTimelineItems(items);
    expect(screen.queryByText(/AskUserQuestion \d (files|calls)/)).toBeNull();
    expect(screen.getByText(/Ship it\?/)).toBeInTheDocument();
    expect(screen.getByText(/Deploy now\?/)).toBeInTheDocument();
  });

  // The toolId-less shape older REST-paged history produces (see the adjacency test in the
  // AskUserQuestion describe block above) must ALSO group correctly: each run member is
  // paired with its result by array-adjacency (there's no toolId to match by), so the group
  // must settle (show a real line count) instead of rendering permanently "running…".
  it('groups toolId-less tools, pairing each with its result by array-adjacency', () => {
    const items: ConvItem[] = [
      { kind: 'tool', toolName: 'Read', toolTitle: 'Read one.ts', toolDetail: 'one.ts' },
      { kind: 'tool-result', text: 'x\nx\nx' },
      { kind: 'tool', toolName: 'Read', toolTitle: 'Read two.ts', toolDetail: 'two.ts' },
      { kind: 'tool-result', text: 'x\nx\nx' },
    ];
    renderTimelineItems(items);
    expect(screen.getByText('Read 2 files')).toBeTruthy();
    expect(screen.getByText('6 lines')).toBeTruthy(); // a real, adjacency-derived line count
    expect(screen.queryByText('running…')).toBeNull(); // not permanently force-expanded
  });

  // THE key-stability test: grouping and scroll preservation are otherwise never exercised
  // together. MessageScroller's preserveScrollOnPrepend tracks the reader's scroll anchor
  // by DOM NODE IDENTITY, so a loadOlder() prepend must not unmount/remount an
  // already-rendered group — it must land as a new SIBLING before it instead.
  it('does not remount an already-expanded group when loadOlder() prepends an older page', () => {
    // The "currently loaded" page: one run of two Reads.
    const items = [...read('c', 'three.ts', 3), ...read('d', 'four.ts', 3)];
    const { container, rerender } = renderTimelineItems(items);

    fireEvent.click(screen.getByText('Read 2 files'));
    expect(screen.getByText('three.ts')).toBeTruthy(); // expanded

    const groupNodeBefore = container.querySelector('[data-message-id="d"]');
    expect(groupNodeBefore).not.toBeNull();

    // loadOlder() prepends an older page — its own run of two Reads — in front. ChatView's
    // real pageBoundariesRef records the PREVIOUS first item (`items[0]`, the 'c' tool) as
    // a permanent boundary at exactly this point.
    const olderPage = [...read('a', 'one.ts', 3), ...read('b', 'two.ts', 3)];
    const prepended = [...olderPage, ...items];
    rerender(
      <MessageScroller.Provider>
        <MessageScroller.Root>
          <MessageScroller.Viewport>
            <MessageScroller.Content>
              {renderTimeline(prepended, () => {}, new Set([items[0]]))}
            </MessageScroller.Content>
          </MessageScroller.Viewport>
        </MessageScroller.Root>
      </MessageScroller.Provider>,
    );

    expect(screen.getByText('three.ts')).toBeTruthy(); // still expanded
    // Same DOM node — not unmounted/remounted. This is the actual scroll-preservation
    // contract MessageScroller relies on; toBe (not toEqual) checks object identity.
    expect(container.querySelector('[data-message-id="d"]')).toBe(groupNodeBefore);
    // Two SEPARATE groups now render — the prepended page's own run, plus the pre-existing
    // group — rather than one run of 4 merged across the boundary.
    expect(screen.getAllByText('Read 2 files')).toHaveLength(2);
  });
});

// ---- ToolGroup tri-state expansion + the batched (parallel tool-call) pairing shape ---
// Pre-merge review fixes: (1) expansion must be TRI-STATE — `undefined` (untouched) is the
// only state that follows the running/settled auto rule; once the reader manually toggles
// it, that choice wins permanently, including across a running→settled transition. The old
// `open || running` logic instead forced the group back open on every re-render while any
// member was running, making a manual collapse a no-op. (2) Claude Code emits parallel
// same-tool calls as tool_use blocks in ONE assistant message with ALL their tool_results in
// the NEXT user message — items flatten to [T,T,R,R], NOT the interleaved [T,R,T,R] shape
// every toolId-less test above covers. Plain `items[idx+1]` adjacency mispairs that shape
// (the first tool's "result" is the SECOND TOOL, i.e. none at all), which combined with (1)
// left the group stuck expanded forever with a dead collapse button.
describe('renderTimeline — ToolGroup tri-state expansion', () => {
  // THE IMPORTANT ONE.
  it('settles (a real line count, not stuck "running…") and can be expanded/collapsed for the BATCHED [T,T,R,R] shape, with no toolIds', () => {
    const items: ConvItem[] = [
      { kind: 'tool', toolName: 'Read', toolTitle: 'Read one.ts', toolDetail: 'one.ts' },
      { kind: 'tool', toolName: 'Read', toolTitle: 'Read two.ts', toolDetail: 'two.ts' },
      { kind: 'tool-result', text: 'x\nx\nx' },
      { kind: 'tool-result', text: 'x\nx\nx' },
    ];
    renderTimelineItems(items);
    expect(screen.getByText('6 lines')).toBeTruthy(); // en-bloc pairing: 3 + 3, not stuck on one orphaned member
    expect(screen.queryByText('running…')).toBeNull();

    const header = screen.getByRole('button', { name: /Read 2 files/ });
    expect(header).toHaveAttribute('aria-expanded', 'false'); // untouched + settled -> auto-collapsed

    fireEvent.click(header); // manual expand
    expect(screen.getByText('one.ts')).toBeTruthy();
    expect(screen.getByText('two.ts')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Read 2 files/ })); // manual collapse
    expect(screen.queryByText('one.ts')).toBeNull();
    expect(screen.queryByText('two.ts')).toBeNull();
    expect(screen.getByRole('button', { name: /Read 2 files/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('a manual collapse survives a member still running', () => {
    const items: ConvItem[] = [
      { kind: 'tool', toolId: 'grp-b1', toolName: 'Read', toolTitle: 'Read one.ts', toolDetail: 'one.ts' },
      { kind: 'tool-result', toolId: 'grp-b1', text: 'x\nx\nx' },
      { kind: 'tool', toolId: 'grp-b2', toolName: 'Read', toolTitle: 'Read two.ts', toolDetail: 'two.ts' }, // still running — no result at all
    ];
    renderTimelineItems(items);
    expect(screen.getByText('one.ts')).toBeTruthy(); // untouched + a member running -> auto-expanded

    fireEvent.click(screen.getByRole('button', { name: /Read 2 (files|calls)/ }));

    // Still running (no rerender) — the OLD `open || running` logic would force this back
    // open, making the collapse click a no-op. The manual collapse must stick regardless.
    expect(screen.getByText('running…')).toBeTruthy(); // genuinely still running
    expect(screen.queryByText('one.ts')).toBeNull();
    expect(screen.getByRole('button', { name: /Read 2 (files|calls)/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('a manual expand survives the run settling', () => {
    const running: ConvItem[] = [
      { kind: 'tool', toolId: 'grp-c1', toolName: 'Read', toolTitle: 'Read one.ts', toolDetail: 'one.ts' },
      { kind: 'tool-result', toolId: 'grp-c1', text: 'x\nx\nx' },
      { kind: 'tool', toolId: 'grp-c2', toolName: 'Read', toolTitle: 'Read two.ts', toolDetail: 'two.ts' }, // still running
    ];
    const { rerender } = renderTimelineItems(running);
    expect(screen.getByText('one.ts')).toBeTruthy(); // auto-expanded while running

    // Collapse, then explicitly re-expand — an unambiguous MANUAL `true`, not merely the
    // still-running auto default.
    fireEvent.click(screen.getByRole('button', { name: /Read 2 (files|calls)/ }));
    expect(screen.queryByText('one.ts')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Read 2 (files|calls)/ }));
    expect(screen.getByText('one.ts')).toBeTruthy();

    // The run settles — 'grp-c2' now has its result too.
    const settled: ConvItem[] = [running[0], running[1], running[2], { kind: 'tool-result', toolId: 'grp-c2', text: 'x\nx\nx' }];
    rerender(
      <MessageScroller.Provider>
        <MessageScroller.Root>
          <MessageScroller.Viewport>
            <MessageScroller.Content>
              {renderTimeline(settled, () => {}, new Set())}
            </MessageScroller.Content>
          </MessageScroller.Viewport>
        </MessageScroller.Root>
      </MessageScroller.Provider>,
    );

    // Still expanded — the manual choice wins over the now-settled auto-collapse rule.
    expect(screen.getByText('one.ts')).toBeTruthy();
    expect(screen.getByText('two.ts')).toBeTruthy();
    expect(screen.queryByText('running…')).toBeNull(); // genuinely settled now
    expect(screen.getByRole('button', { name: /Read 2 files/ })).toHaveAttribute('aria-expanded', 'true');
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

// Regression coverage for the two reported Pretty-mode bugs, both visible in one screenshot:
// a background-task notification rendered as a green user bubble full of raw XML, and the
// tool call directly beneath it rendered wrong.
describe('system-injected task notifications', () => {
  const NOTICE: ConvItem = {
    kind: 'notice',
    uuid: 'n1',
    text: 'Background command "Wait for the deploy to finish" completed (exit code 0)',
  };

  it('renders the summary as a muted notice, not a user bubble', () => {
    // Claude Code writes these as `role: 'user'` lines with no isMeta flag, so before the
    // fix they took the `kind: 'user'` path and got the human's right-aligned accent bubble.
    renderTimelineItems([NOTICE]);
    expect(screen.getByText(/Wait for the deploy to finish/)).toBeInTheDocument();
    // The bookkeeping XML the bubble used to display verbatim is gone.
    expect(screen.queryByText(/task-notification|tool-use-id|output-file/)).toBeNull();
  });

  it('does not break the assistant turn it interrupts', () => {
    // A real `user` turn flushes the group so it can render its own bubble. A notice must
    // NOT: the assistant acts on the notification in its very next block, and splitting the
    // column there would present one continuous turn as two.
    const before: ConvItem = { kind: 'assistant', uuid: 'a1', text: 'starting the deploy' };
    const after: ConvItem = { kind: 'assistant', uuid: 'a2', text: 'deploy is done' };
    const { container } = renderTimelineItems([before, NOTICE, after]);
    // One assistant column, not two — MessageScroller.Item is the per-group wrapper.
    expect(container.querySelectorAll('[data-message-id]').length).toBe(1);
  });

  it('still gives a genuine human turn its own bubble', () => {
    const human: ConvItem = { kind: 'user', uuid: 'u1', text: 'ship it' };
    const assistant: ConvItem = { kind: 'assistant', uuid: 'a1', text: 'on it' };
    const { container } = renderTimelineItems([human, assistant]);
    expect(container.querySelectorAll('[data-message-id]').length).toBe(2);
  });
});

describe('tool rows with no tool ids (REST-paged history)', () => {
  // conversation/transcript.ts emits no toolId on either side, so the tool pairs with its
  // result by array adjacency. The `toolIds.has(...)` guard can only recognize an ID-based
  // pairing, so the same output used to render twice: folded into the tool row's "N lines",
  // then again as a stray "Output · N lines" row directly beneath it.
  it('renders an adjacency-paired result once, not twice', () => {
    const tool: ConvItem = { kind: 'tool', uuid: 't1', toolName: 'Bash', toolDetail: 'cat /tmp/out' };
    const result: ConvItem = { kind: 'tool-result', uuid: 'r1', text: 'line one\nline two' };
    renderTimelineItems([tool, result]);
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText('2 lines')).toBeInTheDocument();
    // The duplicate standalone row is gone.
    expect(screen.queryByText(/^Output$/)).toBeNull();
  });

  it('still renders an ORPHAN result standalone', () => {
    // No preceding tool to claim it — dropping it would lose output entirely.
    const orphan: ConvItem = { kind: 'tool-result', uuid: 'r1', text: 'stray output' };
    renderTimelineItems([orphan]);
    expect(screen.getByText('Output')).toBeInTheDocument();
  });

  it('keeps the tool NAME intact when the detail is long', () => {
    // The name span used to be `flex: 0 1 auto`; CSS apportions shrinkage by flex-basis, so
    // a long command clipped "Bash" to "B…". It is now flexShrink: 0.
    const tool: ConvItem = {
      kind: 'tool', uuid: 't1', toolName: 'Bash',
      toolDetail: 'cat /private/tmp/claude-501/-Users-davidwebber-Sites-explorer/7ff14008-0121-41f7-9dff-e6f82f1eace2/tasks/bdjq1tq9y.output',
    };
    renderTimelineItems([tool, { kind: 'tool-result', uuid: 'r1', text: 'ok' }]);
    const name = screen.getByText('Bash');
    expect(name).toBeInTheDocument();
    expect(name.style.flexShrink).toBe('0');
  });
});
