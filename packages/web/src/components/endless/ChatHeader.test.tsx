// The rules of the Chat header, its menu, its one thread list and its running pill (owner, 2026-11-27).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { ChatHeader, ringWords } from './ChatHeader';
import { ChatAccountSheet } from './ChatAccount';
import { THREADS_ICON } from '../common/viewIcons';
import { api } from '../../api/client';
import { ChatThreadsList, RunningPill, chatRowMeta, ranFor, type ChatThread } from './ChatThreads';
import { useEndless } from '../../stores/endless';
import { usePickerRequest } from '../../stores/pickerRequest';
import { usePluginRegistry } from '../../plugins/registry';
import { useAccounts } from '../../stores/accounts';
import { useUsageLimits } from '../../stores/usageLimits';
import { useThreadStatus } from '../../stores/threadStatus';

const NOW = Date.parse('2026-11-27T20:00:00Z');
const thread = (id: string, state: string, over: Record<string, unknown> = {}) => ({
  id, project: 's1', label: `Thread ${id}`, harness: 'claude-code', state, startedBy: 'chat', via: null,
  startedAt: new Date(NOW - 12 * 60_000).toISOString(), lastActivityAt: new Date(NOW - 60_000).toISOString(), question: null, ...over,
});
const handlers = () => ({ onThreads: vi.fn(), onMemory: vi.fn(), onProjects: vi.fn() });

beforeEach(() => {
  vi.restoreAllMocks();
  usePickerRequest.getState().clear();
  useThreadStatus.setState({ byTerminal: {} } as never);
  useEndless.setState({
    turn: { status: 'idle', error: null }, threads: [], projects: [{ id: 's1', name: 'Dispatch' }],
    settings: { model: null, effort: null, defaultModel: 'opus', accountId: null },
  } as never);
  useAccounts.setState({ view: { claude: [{ id: 'cli', label: 'Ultra 1', isCli: true, addedAt: null }], codex: [], defaults: { claude: 'cli', codex: 'cli' } }, loading: false } as never);
  useUsageLimits.setState({ summary: { warnPercent: 80, paused: [], providers: [{ provider: 'claude-code', accountId: 'cli', label: 'Ultra 1', asOf: Date.now(), windows: { seven_day: { usedPercent: 59, resetsAt: Date.now() + 86_400_000 } } }] } } as never);
  usePluginRegistry.setState({ views: [], badges: {} } as never);
});

describe('the header row', () => {
  it('the title line says the model and effort, never the account, and opens model and effort', () => {
    useEndless.setState({ settings: { model: 'opus', effort: 'high', defaultModel: 'opus', accountId: null } } as never);
    render(<ChatHeader threadsOpen={false} {...handlers()} />);
    expect(screen.getByTestId('chat-status')).toHaveTextContent(/^Opus · high$/);
    expect(screen.queryByTestId('chat-working-dot')).toBeNull();
    fireEvent.click(screen.getByTestId('chat-title'));
    expect(usePickerRequest.getState().owner).toBe('chat');
  });

  it('shows the dot and "Working" only while a turn runs', () => {
    useEndless.setState({ turn: { status: 'running', error: null } } as never);
    render(<ChatHeader threadsOpen={false} {...handlers()} />);
    expect(screen.getByTestId('chat-status')).toHaveTextContent(/^Working · Opus$/);
    expect(screen.getByTestId('chat-working-dot')).toBeInTheDocument();
  });

  it('Threads has a count only when a thread of Chat needs you', () => {
    const h = handlers();
    useEndless.setState({ threads: [thread('a', 'working'), thread('b', 'needs_you', { startedBy: 'user' })] } as never);
    render(<ChatHeader threadsOpen {...h} />);
    expect(screen.queryByTestId('chat-threads-count')).toBeNull();
    act(() => useEndless.setState({ threads: [thread('c', 'needs_you'), thread('d', 'needs_you')] } as never));
    const button = screen.getByRole('button', { name: 'Threads, 2 need you' });
    const drawn = render(<THREADS_ICON size={21} weight="fill" />).container.querySelector('svg')!.innerHTML;
    expect(button.querySelector('svg')!.innerHTML).toBe(drawn); // the app's one Threads icon
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('chat-threads-count')).toHaveTextContent('2');
    fireEvent.click(button);
    expect(h.onThreads).toHaveBeenCalled();
  });

  it('the ring names the account and the window of its number; the ⋯ button has no dot', () => {
    usePluginRegistry.setState({ badges: { 'plugin:previews:history': 3 } } as never);
    render(<ChatHeader threadsOpen={false} {...handlers()} />);
    expect(screen.getByTestId('chat-usage')).toHaveAccessibleName('Ultra 1, 59% of weekly used');
    expect(screen.getByRole('button', { name: 'Chat menu' }).querySelectorAll('span')).toHaveLength(0);
    expect(ringWords('Team', { used: null } as never)).toBe('Team, no usage figure yet');
  });

  it('search opens in the row and closes again', () => {
    render(<ChatHeader threadsOpen={false} {...handlers()} />);
    expect(screen.queryByRole('textbox', { name: 'Search memory' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Search memory' }));
    expect(screen.getByRole('textbox', { name: 'Search memory' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Close search' }));
    expect(screen.queryByRole('textbox', { name: 'Search memory' })).toBeNull();
  });
});

describe('the ⋯ menu', () => {
  const open = () => fireEvent.click(screen.getByRole('button', { name: 'Chat menu' }));

  it('has three tiles with their values, Projects, the Inbox first among plugins, then retry and reload', () => {
    usePluginRegistry.setState({ views: [{ key: 'plugin:z:v', plugin: 'z', id: 'v', label: 'Zed', Component: () => null }, { key: 'plugin:previews:history', plugin: 'previews', id: 'history', label: 'Inbox', Component: () => null }], badges: { 'plugin:previews:history': 3 } } as never);
    const h = handlers();
    render(<ChatHeader threadsOpen={false} {...h} />);
    open();
    const menu = screen.getByRole('menu', { name: 'Chat options' });
    const tiles = within(within(menu).getByRole('group', { name: 'Quick actions' })).getAllByRole('button');
    expect(tiles.map((t) => t.textContent)).toEqual(['ModelOpus', 'AccountUltra 1 · 59%', 'Memory']);
    expect(within(within(menu).getByRole('group', { name: 'Plugins' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['Inbox3', 'Zed']);
    const text = menu.textContent ?? '';
    expect(text).not.toMatch(/Usage and account|Chat instructions/);
    expect(text.indexOf('Retry last message')).toBeLessThan(text.indexOf('Reload Chat'));
    fireEvent.click(within(menu).getByRole('button', { name: 'Projects' }));
    expect(h.onProjects).toHaveBeenCalled();
  });

  it('while a turn runs, offers Stop in place of Retry', () => {
    useEndless.setState({ turn: { status: 'running', error: null } } as never);
    render(<ChatHeader threadsOpen={false} {...handlers()} />);
    open();
    expect(screen.getByRole('button', { name: 'Stop this turn' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry last message' })).toBeNull();
  });
});

describe('the one thread list and the running pill', () => {
  const row = (live: string, over: Record<string, unknown> = {}) => ({ ...thread('a', live), live, ...over }) as ChatThread;

  it('a row says only what its heading does not', () => {
    expect(chatRowMeta(row('working'), 'Dispatch', NOW).text).toBe('Dispatch · 12 min');
    expect(chatRowMeta(row('needs_you'), 'Dispatch', NOW)).toEqual({ text: 'Dispatch · waiting on you', color: 'var(--color-status-yellow)' });
    expect(chatRowMeta(row('done'), 'Dispatch', NOW).text).toMatch(/^Dispatch · finished \d\d:\d\d$/);
    expect(chatRowMeta(row('queued'), 'Dispatch', NOW).text).toBe('Dispatch');
    expect(chatRowMeta(row('working', { harness: 'codex' }), 'Dispatch', NOW).text).toBe('Dispatch · Codex · 12 min');
    expect(ranFor(new Date(NOW - 125 * 60_000).toISOString(), NOW)).toBe('2 h 5 min');
    expect(ranFor(new Date(NOW).toISOString(), NOW)).toBe('<1 min');
  });

  it('groups the threads of Chat by their live state', () => {
    useEndless.setState({ threads: [thread('n', 'needs_you'), thread('r', 'working'), thread('q', 'queued'), thread('f', 'done'), thread('x', 'working', { startedBy: 'user' })] } as never);
    render(<ChatThreadsList />);
    const text = screen.getByTestId('chat-threads').textContent ?? '';
    expect(['Needs you · 1', 'Running · 1', 'Queued · 1', 'Finished today · 1'].every((h) => text.includes(h))).toBe(true);
    expect(text).not.toContain('Thread x');
    expect(screen.getAllByLabelText('Started by an agent')).toHaveLength(4); // the tree badge, on every row
  });

  it('an agent thread keeps its type glyph, bubble or terminal, with the tree badge on it', () => {
    useEndless.setState({ threads: [thread('chat', 'working', { structured: true }), thread('term', 'working', { structured: false })] } as never);
    render(<ChatThreadsList />);
    const [bubble, terminal] = screen.getAllByTitle('Started by an agent, not by you');
    expect(bubble).toHaveAttribute('data-glyph', 'bubble');
    expect(terminal).toHaveAttribute('data-glyph', 'terminal');
    expect(bubble.querySelector('[data-agent-badge]')).not.toBeNull();
  });

  it('the pill counts the running threads, opens the list, and goes away when none run', () => {
    const onOpen = vi.fn();
    useEndless.setState({ threads: [thread('a', 'working'), thread('b', 'working'), thread('c', 'needs_you')] } as never);
    render(<RunningPill onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: '2 threads running' }));
    expect(onOpen).toHaveBeenCalled();
    act(() => useThreadStatus.setState({ byTerminal: { a: { status: 'waiting' } } } as never));
    expect(screen.getByTestId('running-pill')).toHaveTextContent(/^1 thread$/);
    act(() => useThreadStatus.setState({ byTerminal: { a: { status: 'waiting' }, b: { status: 'waiting' } } } as never));
    expect(screen.queryByTestId('running-pill')).toBeNull();
  });
});

describe('the account sheet', () => {
  const twoAccounts = () => useAccounts.setState({ view: { claude: [{ id: 'cli', label: 'Ultra 1', isCli: true, addedAt: null }, { id: 'a2', label: 'Team', isCli: false, addedAt: null }], codex: [{ id: 'x', label: 'Pro', isCli: false, addedAt: null }], defaults: { claude: 'cli', codex: 'cli' } }, reload: async () => {} } as never);

  it('starts on "Default account", lists the Claude accounts only, and saves a pick', async () => {
    twoAccounts();
    const put = vi.spyOn(api, 'setEndlessSettings').mockResolvedValue({ model: null, effort: null, defaultModel: 'opus', accountId: 'a2' });
    render(<ChatAccountSheet open onClose={() => {}} />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3); // no Codex account
    ['Default account', 'Ultra 1', 'Team'].forEach((name, i) => expect(radios[i]).toHaveTextContent(name));
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    await act(async () => { fireEvent.click(radios[2]); });
    expect(put).toHaveBeenCalledWith({ accountId: 'a2' });
    expect(screen.getAllByRole('radio')[2]).toHaveAttribute('aria-checked', 'true');
  });

  it('shows why a change was refused', async () => {
    twoAccounts();
    vi.spyOn(api, 'setEndlessSettings').mockRejectedValue(new Error('That account cannot run Chat.'));
    render(<ChatAccountSheet open onClose={() => {}} />);
    await act(async () => { fireEvent.click(screen.getAllByRole('radio')[2]); });
    expect(screen.getByRole('alert')).toHaveTextContent('That account cannot run Chat.');
  });

  it('offers no switch on a daemon without the setting', () => {
    twoAccounts();
    useEndless.setState({ settings: { model: null, effort: null, defaultModel: 'opus' } } as never);
    render(<ChatAccountSheet open onClose={() => {}} />);
    expect(screen.getAllByRole('radio').every((r) => (r as HTMLButtonElement).disabled)).toBe(true);
  });
});
