import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { createPluginSdk } from './facade';
import { useProjects } from '../stores/projects';
// The bundled Inbox plugin (id previews) is plain JS.
import activate from '../../../plugins/previews/web.js';

// Inbox → Send a secret (2026-11-12): the owner hands a thread an API key by a short ID, never through the chat.
// The value goes to the daemon once and is never shown again; the Inbox lists the secret as a card with its state.

const VALUE = 'sk_live_WEB_TEST_SECRET';
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const rec = (id: string, extra: Record<string, unknown>) => ({
  id, sessionId: 's1', terminalId: null, terminalLabel: null, name: `Secret ${id}`, allowReveal: false,
  createdAt: iso(60_000), expiresAt: iso(-3_600_000), usedAt: null, usedBy: null, usedByLabel: null, usedTo: null, state: 'waiting', ...extra,
});

type Call = { url: string; method: string; body: any; bound: string | null };
function setup(records: Record<string, unknown>[] = [], created = 'K7Q2M4') {
  useProjects.setState({ sessions: [{ id: 's1', name: 'Alpha' }, { id: 's2', name: 'Beta' }] as never });
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string, init: RequestInit = {}) => {
    const url = String(u);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body, bound: new Headers(init.headers).get('X-Dispatch-Plugin-Bound') });
    if (url.includes('/api/plugins/previews/secrets') && method === 'GET') return { ok: true, status: 200, json: async () => ({ secrets: records }) };
    if (url.endsWith('/api/plugins/previews/secrets') && method === 'POST') {
      return { ok: true, status: 201, json: async () => rec(created, { name: body.name, sessionId: body.sessionId ?? 's1', terminalId: body.terminalId ?? null, allowReveal: !!body.allowReveal, createdAt: new Date().toISOString() }) };
    }
    if (method === 'DELETE') return { ok: true, status: 204, json: async () => null };
    return { ok: false, status: 404, json: async () => ({ error: 'nope' }) };
  }));
  const sdk = createPluginSdk('previews');
  const copy = vi.fn(async () => {});
  const reg: Record<string, any> = { views: [], inspectorTabs: [], projectMenu: [], slots: [] };
  const d = {
    ...sdk,
    ui: { ...sdk.ui, copyText: copy },
    docs: { ...sdk.docs, entries: vi.fn(async () => []), set: vi.fn(async () => {}) },
    events: { on: () => () => {} },
    register: (c: Record<string, any[]>) => { for (const k of Object.keys(reg)) reg[k].push(...(c[k] ?? [])); },
  };
  activate(d as never);
  return {
    History: reg.views[0].Component, Tab: reg.inspectorTabs[0].Component, Sheet: reg.slots.find((s: { id: string }) => s.id === 'sheet').Component,
    openSheet: () => act(() => reg.projectMenu[0].onPick({ session: { id: 's1' } })), copy, calls,
  };
}
afterEach(() => { vi.unstubAllGlobals(); });

const fill = () => {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Stripe key' } });
  fireEvent.change(screen.getByLabelText('Value'), { target: { value: VALUE } });
};

describe('Send a secret: the sheet', () => {
  it('the project sheet has a Send a secret button; the sheet has Name, a password Value and the read switch off', async () => {
    const { Sheet, openSheet } = setup();
    render(<Sheet />);
    openSheet();
    fireEvent.click(await screen.findByRole('button', { name: 'Send a secret' }));
    const dialog = await screen.findByTestId('send-secret');
    expect(within(dialog).getByLabelText('Name')).toHaveAttribute('type', 'text');
    const value = within(dialog).getByLabelText('Value');
    expect(value).toHaveAttribute('type', 'password');
    expect(value).toHaveAttribute('autocomplete', 'new-password');
    const sw = within(dialog).getByRole('switch', { name: 'Let the thread read it' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(within(dialog).getByText(/any thread of Alpha/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('send (project scope) posts the value once, then shows the ID, a Copy ID and a Copy line; the value is gone from the page', async () => {
    const { Sheet, openSheet, calls, copy } = setup();
    render(<Sheet />);
    openSheet();
    fireEvent.click(await screen.findByRole('button', { name: 'Send a secret' }));
    fill();
    fireEvent.click(screen.getByRole('switch', { name: 'Let the thread read it' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByTestId('secret-id')).toHaveTextContent('K7Q2M4');
    const post = calls.filter((c) => c.method === 'POST');
    expect(post).toHaveLength(1);
    expect(post[0].url).toMatch(/\/api\/plugins\/previews\/secrets$/);
    expect(post[0].body).toEqual({ name: 'Stripe key', value: VALUE, sessionId: 's1', allowReveal: true });
    // The Inbox plugin's own routes, bound to it (W3-F).
    expect(calls.every((c) => /\/api\/plugins\/previews\/secrets/.test(c.url) && c.bound === 'previews')).toBe(true);
    expect(document.body.innerHTML).not.toContain(VALUE);
    const sheet = screen.getByTestId('send-secret');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Copy ID' }));
    expect(copy).toHaveBeenLastCalledWith('K7Q2M4');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Copy line' }));
    expect(copy).toHaveBeenLastCalledWith('The secret "Stripe key" is in my Inbox: K7Q2M4');
    expect(within(sheet).getByText('The secret "Stripe key" is in my Inbox: K7Q2M4')).toBeInTheDocument();
    // The new secret is in the list under the sheet at once.
    expect(screen.getAllByTestId('sent-secret')).toHaveLength(1);
  });

  it('from the thread tab the secret is for that thread only', async () => {
    const { Tab, calls } = setup();
    render(<Tab terminalId="t1" sessionId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send a secret' }));
    expect(screen.getByText(/this thread only/)).toBeInTheDocument();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByTestId('secret-id');
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ name: 'Stripe key', value: VALUE, sessionId: 's1', terminalId: 't1', allowReveal: false });
  });

  it('from the Inbox view a project is required', async () => {
    const { History } = setup();
    render(<History />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send a secret' }));
    fill();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByText('Choose a project')).toBeInTheDocument();
  });

  it('an error of the daemon shows, and the value is never in it', async () => {
    const { Sheet, openSheet } = setup();
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit = {}) => ((init.method ?? 'GET') === 'POST'
      ? { ok: false, status: 404, json: async () => ({ error: 'project not found' }) }
      : { ok: true, status: 200, json: async () => ({ secrets: [] }) })));
    render(<Sheet />);
    openSheet();
    fireEvent.click(await screen.findByRole('button', { name: 'Send a secret' }));
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/project not found/)).toBeInTheDocument();
  });
});

describe('Send a secret: the cards', () => {
  const RECORDS = [
    rec('WAIT22', { name: 'Stripe key' }),
    rec('USED33', { name: 'OpenAI key', terminalId: 't1', terminalLabel: 'Perf', state: 'used', usedAt: iso(30_000), usedBy: 't1', usedByLabel: 'Perf', usedTo: { kind: 'file', path: '.env.local', name: 'OPENAI_API_KEY' } }),
    rec('DOPP44', { name: 'Doppler one', state: 'used', usedAt: iso(30_000), usedBy: 't2', usedByLabel: 'Builder', usedTo: { kind: 'doppler', name: 'SENTRY_DSN' } }),
    rec('GONE55', { name: 'Old token', createdAt: iso(25 * 3_600_000), state: 'expired' }),
  ];
  const card = (title: string) => screen.getByText(title).closest('[data-testid="sent-secret"]') as HTMLElement;

  it('the Inbox shows a Secret card per secret: name, ID, scope, state', async () => {
    const { History } = setup(RECORDS);
    render(<History />);
    await screen.findByText('Stripe key');
    const wait = card('Stripe key');
    expect(wait).toHaveAttribute('data-state', 'waiting');
    expect(within(wait).getByTestId('drop-kind')).toHaveTextContent('Secret');
    expect(within(wait).getByText('WAIT22')).toBeInTheDocument();
    expect(within(wait).getByText(/Any thread of Alpha/)).toBeInTheDocument();
    expect(within(wait).getByText('Waiting')).toBeInTheDocument();
    expect(within(wait).getByText(/Usable until/)).toBeInTheDocument();
    const used = card('OpenAI key');
    expect(used).toHaveAttribute('data-state', 'used');
    expect(within(used).getByText(/Thread Perf only/)).toBeInTheDocument();
    expect(within(used).getByText(/Used by Perf/)).toBeInTheDocument();
    expect(within(used).getByText(/OPENAI_API_KEY in \.env\.local/)).toBeInTheDocument();
    expect(within(card('Doppler one')).getByText(/Doppler SENTRY_DSN/)).toBeInTheDocument();
    const gone = card('Old token');
    expect(gone).toHaveAttribute('data-state', 'expired');
    expect(within(gone).getByText('Expired')).toBeInTheDocument();
    expect(within(gone).queryByRole('button', { name: 'Copy ID' })).toBeNull();
  });

  it('a waiting card copies its ID; a used one does not offer it', async () => {
    const { History, copy } = setup(RECORDS);
    render(<History />);
    await screen.findByText('Stripe key');
    fireEvent.click(within(card('Stripe key')).getByRole('button', { name: 'Copy ID' }));
    expect(copy).toHaveBeenLastCalledWith('WAIT22');
    expect(within(card('OpenAI key')).queryByRole('button', { name: 'Copy ID' })).toBeNull();
  });

  it('Delete removes the secret on the daemon and from the list', async () => {
    const { History, calls } = setup(RECORDS);
    render(<History />);
    await screen.findByText('Stripe key');
    fireEvent.click(within(card('Stripe key')).getByRole('button', { name: 'Delete secret' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/api/plugins/previews/secrets/WAIT22'))).toBe(true));
    await waitFor(() => expect(screen.queryByText('Stripe key')).toBeNull());
  });

  it('the thread tab shows the secrets of that thread (for it, or used by it)', async () => {
    const { Tab } = setup(RECORDS);
    render(<Tab terminalId="t1" sessionId="s1" />);
    expect(await screen.findByText('OpenAI key')).toBeInTheDocument();
    expect(screen.queryByText('Stripe key')).toBeNull();
    expect(screen.queryByText('Doppler one')).toBeNull();
  });

  it('the project sheet shows the project secrets', async () => {
    const { Sheet, openSheet } = setup(RECORDS);
    render(<Sheet />);
    openSheet();
    expect(await screen.findByText('Stripe key')).toBeInTheDocument();
    expect(screen.getByText('Old token')).toBeInTheDocument();
  });
});
