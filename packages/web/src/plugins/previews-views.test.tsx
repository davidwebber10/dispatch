import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor, act, cleanup } from '@testing-library/react';
import { createPluginSdk } from './facade';
import { useProjects } from '../stores/projects';
// The bundled Inbox plugin (id previews) is plain JS.
import activate from '../../../plugins/previews/web.js';

// Inbox 1.3.0 (Dispatch 4.15.0): two views, Rows (default) and Cards, with a toggle in the top row.
// The choice is the plugin's own setting, so it stays across reloads, restarts and devices.

const NOW = Date.now();
const doc = (id: string, extra: Record<string, unknown>) => ({
  id, sessionId: 's1', sessionName: 'Alpha', terminalId: 't1', terminalLabel: 'Perf', title: `Item ${id}`, note: null, text: null, files: [],
  createdAt: new Date(NOW - 60_000).toISOString(), seenAt: 'seen', ...extra,
});
const png = (n: number) => ({ fileId: `f${n}`, name: `shot-${n}.png`, mime: 'image/png', size: 10 });
const DOCS = [
  doc('shots', { title: 'Six shots', note: 'The note of the shots.', files: [1, 2, 3, 4, 5, 6].map(png), seenAt: null }),
  doc('cmd', { title: 'Build it', kind: 'command', commands: ['make', 'make test'], text: 'make\nmake test', createdAt: new Date(NOW - 120_000).toISOString() }),
];

const glyph = (name: string) => () => <svg data-testid={`icon-${name}`} />;
const openSearch = () => fireEvent.click(screen.getByRole('button', { name: 'Search items' }));
const topRow = () => document.querySelector('[data-filterbar-row]') as HTMLElement;

function setup(saved: unknown = null, { slow = false } = {}) {
  useProjects.setState({ sessions: [{ id: 's1', name: 'Alpha' }] as never });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ secrets: [] }) })));
  const store = { value: saved };
  let release: () => void = () => {};
  const gate = slow ? new Promise<void>((r) => { release = r; }) : Promise.resolve();
  const settings = {
    get: vi.fn(async (fallback?: unknown) => { const v = store.value; await gate; return v ?? fallback ?? null; }),
    set: vi.fn(async (v: unknown) => { store.value = v; }),
  };
  const set = vi.fn(async () => {});
  const handlers: Record<string, (e: unknown) => void> = {};
  const reg: Record<string, any> = { views: [], inspectorTabs: [], projectMenu: [], slots: [] };
  const sdk = createPluginSdk('previews');
  const d = {
    ...sdk,
    icons: { ...sdk.icons, key: glyph('key'), 'paper-plane': glyph('paper-plane'), lock: glyph('lock') },
    settings,
    docs: { ...sdk.docs, entries: vi.fn(async () => DOCS.map((v) => ({ key: `preview:${v.id}`, value: v }))), set },
    events: { on: (name: string, fn: (e: unknown) => void) => { handlers[name] = fn; return () => {}; } },
    register: (c: Record<string, any[]>) => { for (const k of Object.keys(reg)) reg[k].push(...(c[k] ?? [])); },
  };
  activate(d as never);
  return {
    History: reg.views[0].Component, Tab: reg.inspectorTabs[0].Component, Sheet: reg.slots.find((s: { id: string }) => s.id === 'sheet').Component,
    openSheet: () => act(() => reg.projectMenu[0].onPick({ session: { id: 's1' } })), settings, store, set, handlers, release: () => release(),
  };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const radio = (name: 'Rows' | 'Cards') => screen.getByRole('radio', { name });
const view = () => screen.getByTestId('inbox-list').dataset.view;
const item = (title: string) => screen.getByText(title).closest('[data-testid="preview-item"]') as HTMLElement;
const tap = (title: string) => fireEvent.click(screen.getByText(title));

describe('Inbox views: the toggle', () => {
  it('starts in Rows, and sits in the one top row with the search button, Filters and Send Secret', async () => {
    const { History } = setup();
    render(<History />);
    await screen.findByText('Six shots');
    expect(view()).toBe('rows');
    expect(radio('Rows')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Cards')).toHaveAttribute('aria-checked', 'false');
    const row = topRow();
    for (const el of [screen.getByRole('button', { name: 'Search items' }), radio('Rows'), radio('Cards'), screen.getByRole('button', { name: 'Filters' }), screen.getByRole('button', { name: 'Send Secret' })]) {
      expect(el.closest('[data-filterbar-row]')).toBe(row);
    }
    expect(screen.queryByRole('heading', { name: 'Inbox' })).toBeNull();
    for (const name of ['Rows', 'Cards'] as const) expect([radio(name).style.width, radio(name).style.height]).toEqual(['44px', '44px']);
  });

  it('Cards switches the view and saves the choice; Rows switches back', async () => {
    const { History, store } = setup();
    render(<History />);
    await screen.findByText('Six shots');
    fireEvent.click(radio('Cards'));
    expect(view()).toBe('cards');
    expect(radio('Cards')).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(store.value).toEqual({ view: 'cards' }));
    fireEvent.click(radio('Rows'));
    expect(view()).toBe('rows');
    await waitFor(() => expect(store.value).toEqual({ view: 'rows' }));
  });

  it('a saved choice comes back after a reload, and other settings stay', async () => {
    const { History, store } = setup({ view: 'cards', other: 1 });
    render(<History />);
    await screen.findByText('Six shots');
    await waitFor(() => expect(view()).toBe('cards'));
    fireEvent.click(radio('Rows'));
    await waitFor(() => expect(store.value).toEqual({ view: 'rows', other: 1 }));
  });

  it('an unknown saved value means Rows', async () => {
    const { History, settings } = setup({ view: 'e' });
    render(<History />);
    await screen.findByText('Six shots');
    await waitFor(() => expect(settings.get).toHaveBeenCalled());
    expect(view()).toBe('rows');
  });

  it('a tap before the setting loads is not undone by the load', async () => {
    const { History, release, store } = setup({ view: 'rows' }, { slow: true });
    render(<History />);
    await screen.findByText('Six shots');
    fireEvent.click(radio('Cards'));
    await act(async () => { release(); });
    expect(view()).toBe('cards');
    await waitFor(() => expect(store.value).toEqual({ view: 'cards' }));
  });

  it('a change on another device arrives with the plugin:settings event', async () => {
    const { History, store, handlers } = setup();
    render(<History />);
    await screen.findByText('Six shots');
    store.value = { view: 'cards' };
    await act(async () => { handlers['plugin:settings']({ type: 'plugin:settings', id: 'previews' }); });
    await waitFor(() => expect(view()).toBe('cards'));
  });

  it('the project sheet and the thread tab use the same choice', async () => {
    const { Sheet, Tab, openSheet } = setup({ view: 'cards' });
    const first = render(<Sheet />);
    openSheet();
    await screen.findByText('Six shots');
    await waitFor(() => expect(view()).toBe('cards'));
    first.unmount();
    render(<Tab terminalId="t1" sessionId="s1" />);
    await screen.findByText('Six shots');
    expect(view()).toBe('cards');
  });
});

describe('Inbox: the search is behind a magnifying glass', () => {
  const ready = async () => {
    const s = setup();
    render(<s.History />);
    await screen.findByText('Six shots');
    return s;
  };

  it('starts closed: no search field, and a 44px magnifying glass with a tooltip', async () => {
    await ready();
    expect(screen.queryByRole('searchbox')).toBeNull();
    const button = screen.getByRole('button', { name: 'Search items' });
    expect(button).toHaveAttribute('title', 'Search items');
    expect([button.style.width, button.style.height]).toEqual(['44px', '44px']);
  });

  it('a tap opens the field with the focus, and the row has Cancel and Filters only', async () => {
    await ready();
    openSearch();
    const field = screen.getByRole('searchbox', { name: 'Search items' });
    expect(field).toHaveFocus();
    expect(field.closest('[data-filterbar-row]')).toBe(topRow());
    expect(screen.getByRole('button', { name: 'Cancel search' })).toHaveTextContent('Cancel');
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'View' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send Secret' })).toBeNull();
  });

  it.each(['Cancel', 'Escape'])('%s closes the search, clears the text and gives the focus back', async (how) => {
    await ready();
    openSearch();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'build' } });
    expect(screen.queryByText('Six shots')).toBeNull();
    if (how === 'Cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel search' }));
    else fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.getByText('Six shots')).toBeInTheDocument(); // no hidden search keeps an item away
    expect(screen.getByRole('button', { name: 'Search items' })).toHaveFocus();
    openSearch();
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });
});

describe('Inbox: the Send Secret button', () => {
  it('reads Send Secret with a paper plane, not a key or a lock, in the Inbox, the project sheet and the thread tab', async () => {
    const s = setup();
    const check = () => {
      const button = screen.getByRole('button', { name: 'Send Secret' });
      expect(button).toHaveTextContent('Send Secret');
      expect(button).toHaveAttribute('title', 'Send Secret');
      expect(within(button).getByTestId('icon-paper-plane')).toBeInTheDocument();
      expect(within(button).queryByTestId('icon-lock')).toBeNull();
      expect(within(button).queryByTestId('icon-key')).toBeNull();
      expect(button.style.height).toBe('44px');
      expect(button.style.whiteSpace).toBe('nowrap');
    };
    const history = render(<s.History />);
    await screen.findByText('Six shots');
    check();
    history.unmount();
    const sheet = render(<s.Sheet />);
    s.openSheet();
    await screen.findByText('Six shots');
    check();
    sheet.unmount();
    render(<s.Tab terminalId="t1" sessionId="s1" />);
    await screen.findByText('Six shots');
    check();
  });
});

describe('Inbox views: Rows', () => {
  it('a closed row has the title and one action, and no note or full content', async () => {
    const { History } = setup();
    render(<History />);
    await screen.findByText('Six shots');
    expect(screen.queryByText('The note of the shots.')).toBeNull();
    expect(screen.queryByTestId('drop-command')).toBeNull();
    expect(within(item('Six shots')).getByRole('button', { name: 'Open 6 images' })).toBeInTheDocument();
    expect(within(item('Build it')).getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
  });
});

describe('Inbox views: Cards', () => {
  it('a closed card has the note, four thumbnails and +2, and the first command with Copy', async () => {
    const { History } = setup({ view: 'cards' });
    render(<History />);
    await screen.findByText('Six shots');
    await waitFor(() => expect(view()).toBe('cards'));
    const shots = item('Six shots');
    expect(within(shots).getByText('The note of the shots.')).toBeInTheDocument();
    expect(shots.querySelectorAll('img')).toHaveLength(4);
    expect(within(shots).getByRole('button', { name: '2 more images' })).toBeInTheDocument();
    expect(within(item('Build it')).getByText('make')).toBeInTheDocument();
    expect(within(item('Build it')).getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
    expect(screen.queryByTestId('drop-command')).toBeNull();
  });
});

describe.each(['rows', 'cards'])('Inbox views: the same behaviour in %s', (mode) => {
  const ready = async () => {
    const s = setup({ view: mode });
    const out = render(<s.History />);
    await screen.findByText('Six shots');
    await waitFor(() => expect(view()).toBe(mode));
    return { ...s, ...out };
  };

  it('a tap opens the item in place with its full content, one at a time; a second tap closes it', async () => {
    await ready();
    tap('Six shots');
    expect(item('Six shots').dataset.open).toBe('true');
    expect(within(item('Six shots')).getByTestId('preview-thumbs').querySelectorAll('img')).toHaveLength(6);
    expect(within(item('Six shots')).getByRole('button', { name: 'Delete item' })).toBeInTheDocument();
    tap('Build it');
    expect(item('Six shots').dataset.open).toBeUndefined();
    expect(within(item('Build it')).getAllByTestId('drop-command')).toHaveLength(2);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(within(item('Build it')).getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('drop-command')).toBeNull();
  });

  it('an unread item shows New; opening it marks it read', async () => {
    const { set } = await ready();
    expect(item('Six shots').dataset.unseen).toBe('true');
    tap('Six shots');
    await waitFor(() => expect(set).toHaveBeenCalledWith('preview:shots', expect.objectContaining({ seenAt: expect.any(String) })));
    expect(item('Six shots').dataset.unseen).toBeUndefined();
  });

  it('leaving the view marks all read', async () => {
    const { set, unmount } = await ready();
    expect(set).not.toHaveBeenCalled();
    unmount();
    await waitFor(() => expect(set).toHaveBeenCalledWith('preview:shots', expect.anything()));
  });

  it('search, Filters and Send Secret work', async () => {
    await ready();
    openSearch();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'build' } });
    expect(screen.queryByText('Six shots')).toBeNull();
    expect(screen.getByText('Build it')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.getByRole('group', { name: 'Project filter' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel search' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send Secret' }));
    expect(await screen.findByTestId('send-secret')).toBeInTheDocument();
  });
});
