// The Control Plane renders its transcript through the thread view's renderTimeline, with
// controlPlaneTimeline's hooks (timeline.tsx). These are the old convItemsToStream cases
// (live.test.ts, pre-unification) re-asserted on the rendered conversation: what each kind of
// ConvItem becomes on screen, plus the Control-Plane-only agent cards and dropped orphans.
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { ConvItem } from '../../api/types';
import { useOverseer } from './store';
import { useProjects } from '../../stores/projects';
import { ConversationStream } from './components/Stream';

beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
  Element.prototype.scrollTo = Element.prototype.scrollTo || (() => {});
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
});

beforeEach(() => {
  useProjects.setState({ activeId: 'proj-1' });
  useOverseer.setState({
    coordinatorId: 'coord-1',
    coordinatorProject: 'proj-1',
    coordinatorItems: [],
    coordinatorBusy: false,
    coordinatorPending: null,
    coordinatorAnswer: () => {},
    setupNeeded: false,
    sendError: null,
  });
});

afterEach(cleanup);

const show = (items: ConvItem[]) => {
  useOverseer.setState({ coordinatorItems: items });
  return render(<ConversationStream />);
};
const call = (toolId: string, toolName: string, args: Record<string, unknown> = {}): ConvItem => ({ kind: 'tool', toolId, toolName, toolInput: JSON.stringify(args) });
const res = (toolId: string, body: unknown = 'ok', isError = false): ConvItem => ({ kind: 'tool-result', toolId, text: typeof body === 'string' ? body : JSON.stringify(body), ...(isError ? { isError } : {}) });
/** Text order in the rendered conversation, for "this came before that". */
const before = (a: string, b: string) => !!(screen.getByText(a).compareDocumentPosition(screen.getByText(b)) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('message attribution', () => {
  const img = (imageFromUser?: boolean, alt = 'pic'): ConvItem => ({ kind: 'image', imageUrl: 'data:image/png;base64,AAAA', imageAlt: alt, imageFromUser });

  it('a human-attached image sits right-aligned on the human\'s side (BUG 3)', () => {
    const { container } = show([img(true, 'mine')]);
    const el = container.querySelector('img[alt="mine"]')!;
    expect(el.closest('[style*="align-self: flex-end"]')).not.toBeNull();
  });

  it('an agent/tool/coordinator image stays in the coordinator\'s (flush-left) turn', () => {
    const { container } = show([img(false, 'theirs')]);
    const el = container.querySelector('img[alt="theirs"]')!;
    expect(el.closest('[style*="align-self: flex-end"]')).toBeNull();
  });

  it('user text is the human\'s bubble (YOU) and assistant text is the coordinator\'s prose, with no speaker label', () => {
    show([{ kind: 'user', text: 'do the thing' }, { kind: 'assistant', text: 'on it' }]);
    expect(screen.getByText('YOU')).toBeInTheDocument();
    expect(screen.getByText('do the thing')).toBeInTheDocument();
    expect(screen.getByText('on it')).toBeInTheDocument();
    expect(screen.queryByText('Control Plane')).not.toBeInTheDocument();
    expect(before('do the thing', 'on it')).toBe(true);
  });
});

describe('around the list: greeting and send error', () => {
  it('an empty conversation shows the canned greeting', () => {
    show([]);
    expect(screen.getByText(/I'm Control Plane — the coordinator for this project/)).toBeInTheDocument();
  });

  it('no greeting once there is a transcript, nor while the setup card is up', () => {
    show([{ kind: 'assistant', text: 'hello' }]);
    expect(screen.queryByText(/I'm Control Plane/)).not.toBeInTheDocument();
    cleanup();
    useOverseer.setState({ setupNeeded: true, coordinatorId: 'coord-1' });
    show([]);
    expect(screen.queryByText(/I'm Control Plane/)).not.toBeInTheDocument();
  });

  it('a failed send shows as an error pill below the conversation', () => {
    useOverseer.setState({ sendError: 'Failed to send message' });
    show([{ kind: 'assistant', text: 'last reply' }]);
    expect(screen.getByText('Failed to send message')).toBeInTheDocument();
    expect(before('last reply', 'Failed to send message')).toBe(true);
  });
});

describe('answered AskUserQuestion', () => {
  it('an answered question is a durable collapsed record', () => {
    show([
      call('tu-1', 'AskUserQuestion', { questions: [{ question: 'Deploy now?', options: ['Yes', 'No'] }] }),
      res('tu-1', 'Your questions have been answered: "Deploy now?"="Yes". You can now continue with these answers in mind.'),
    ]);
    expect(screen.getByText(/Deploy now\?/)).toBeInTheDocument();
  });

  it('a still-pending question (no tool_result yet) draws nothing — the live card owns it', () => {
    show([call('tu-2', 'AskUserQuestion', { questions: [{ question: 'Which env?', options: ['staging', 'prod'] }] })]);
    expect(screen.queryByText('Which env?')).not.toBeInTheDocument();
  });

  it('an answered question and an agent card in the same window both draw', () => {
    show([
      call('tu-3', 'AskUserQuestion', { questions: [{ question: 'Proceed?', options: ['Yes'] }] }),
      call('tu-4', 'spawn_agent', { agentType: 'implementer' }),
      res('tu-3', 'Your questions have been answered: "Proceed?"="Yes". You can now continue with these answers in mind.'),
      res('tu-4', { agentId: 'a1', label: 'Implementer One' }),
    ]);
    expect(screen.getByText(/Proceed\?/)).toBeInTheDocument();
    expect(screen.getByText('Implementer One')).toBeInTheDocument();
  });
});

describe('render parity (machinery, thinking, status, footer, notice)', () => {
  it('a generic tool call + its result draw as one settled tool row (not running, no stray output row)', () => {
    show([call('b1', 'Bash', { command: 'ls' }), res('b1', 'ok')]);
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.queryByText('running…')).not.toBeInTheDocument();
    expect(screen.queryByText('Output')).not.toBeInTheDocument();
  });

  it('prose splits the tool runs: tools, then the prose, then the next tool', () => {
    show([
      call('b1', 'Bash', { command: 'ls' }), res('b1'),
      call('r1', 'Read', { file_path: '/a.md' }), res('r1'),
      { kind: 'assistant', text: 'both ran fine' },
      call('g1', 'Grep', { pattern: 'x' }), res('g1'),
    ]);
    expect(before('Bash', 'both ran fine')).toBe(true);
    expect(before('Read', 'both ran fine')).toBe(true);
    expect(before('both ran fine', 'Grep')).toBe(true);
  });

  it('report_status is a status card and its {ok} result draws no stray row', () => {
    show([
      call('rs1', 'mcp__dispatch__report_status', { state: 'blocked', summary: 'waiting on CI', blocker: 'run 42 pending' }),
      res('rs1', { ok: true }),
    ]);
    expect(screen.getByTestId('status-notice')).toBeInTheDocument();
    expect(screen.queryByText('Output')).not.toBeInTheDocument();
  });

  it('a still-streaming report_status (unparsable input) stays a generic tool row', () => {
    show([{ kind: 'tool', toolId: 'rs1', toolName: 'mcp__dispatch__report_status', toolInput: '{"state":"do' }]);
    expect(screen.queryByTestId('status-notice')).not.toBeInTheDocument();
    expect(screen.getByText('mcp__dispatch__report_status')).toBeInTheDocument();
  });

  it('thinking, a result footer and a background-task notice each draw', () => {
    show([
      { kind: 'thinking', text: 'weighing options' },
      { kind: 'result', costUsd: 0.12, tokensIn: 100, tokensOut: 50, durationMs: 4200 },
      { kind: 'notice', text: 'Background task finished' },
    ]);
    expect(screen.getByText(/weighing options/)).toBeInTheDocument();
    expect(screen.getByText(/150 tok/)).toBeInTheDocument();
    expect(screen.getByText('Background task finished')).toBeInTheDocument();
  });
});

describe('agent cards', () => {
  it('REGRESSION: an agency call + result is an agent card, never a tool row; clicking opens the agent', () => {
    const drillInto = vi.fn();
    useOverseer.setState({ drillInto });
    show([call('s1', 'mcp__dispatch__spawn_agent', { agentType: 'researcher' }), res('s1', { agentId: 'a1', label: 'Digger', mission: 'Delta' })]);
    expect(screen.getByText('Digger')).toBeInTheDocument();
    expect(screen.getByText('Spawned')).toBeInTheDocument();
    expect(screen.getByText('· Delta')).toBeInTheDocument();
    expect(screen.queryByText('mcp__dispatch__spawn_agent')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Open Digger'));
    expect(drillInto).toHaveBeenCalledWith('a1');
  });

  it('a later message_agent card shows the spawned agent\'s name', () => {
    show([
      call('s1', 'mcp__dispatch__spawn_agent', { agentType: 'reviewer' }), res('s1', { agentId: 'a2', label: 'Checker' }),
      call('m1', 'mcp__dispatch__message_agent', { agentId: 'a2', text: 'go' }), res('m1', { ok: true, agentId: 'a2' }),
    ]);
    expect(screen.getAllByText('Checker')).toHaveLength(2);
    expect(screen.getByText('Messaged')).toBeInTheDocument();
  });

  it('two spawns in a row are two cards, not one collapsed tool group', () => {
    show([
      call('s1', 'spawn_agent'), call('s2', 'spawn_agent'),
      res('s1', { agentId: 'a1', label: 'First' }), res('s2', { agentId: 'a2', label: 'Second' }),
    ]);
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.queryByText('×2')).not.toBeInTheDocument();
  });

  it('a spawn still waiting on its result draws nothing yet', () => {
    show([call('s1', 'spawn_agent', { agentType: 'implementer' })]);
    expect(screen.queryByText('spawn_agent')).not.toBeInTheDocument();
    expect(screen.queryByText('running…')).not.toBeInTheDocument();
  });

  it('complete_agent keeps its {ok,agentId} result paired in its tool row (no forever-running row)', () => {
    show([call('c1', 'mcp__dispatch__complete_agent', { agentId: 'a1' }), res('c1', { ok: true, agentId: 'a1' })]);
    expect(screen.getByText('mcp__dispatch__complete_agent')).toBeInTheDocument();
    expect(screen.queryByText('running…')).not.toBeInTheDocument();
  });

  it('a TRUE orphan agency result (its call outside the window) is dropped; a real orphan output is kept', () => {
    show([res('gone', { ok: true, agentId: 'a1' }), { kind: 'assistant', text: 'between' }, res('gone2', 'line1\nline2')]);
    expect(screen.getAllByText('Output')).toHaveLength(1);
  });
});
