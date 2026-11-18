import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor, act } from '@testing-library/react';
import { createPluginSdk } from './facade';
import { useProjects } from '../stores/projects';
// The bundled Previews plugin is plain JS; its user-facing name is "Inbox" (owner, 2026-11-11).
import activate, { NAME, inferKind, maskSecret, parseCsv, filterPreviews } from '../../../plugins/previews/web.js';

// Drops (2026-11-11): one tool, a `kind` per card. The owner reads on an iPhone, often in terminal mode,
// so copying is exact and one tap, and the kinds look different at a glance.

const NOW = Date.now();
const base = (id: string, extra: Record<string, unknown>) => ({
  id, sessionId: 's1', sessionName: 'Alpha', terminalId: 't1', terminalLabel: 'Perf', title: `Drop ${id}`, note: null, text: null, files: [],
  createdAt: new Date(NOW - 60_000).toISOString(), seenAt: 'seen', ...extra,
});
const SECRET = 'sk-live-4f9a8b7c6d5e1234';

type Setup = { History: React.ComponentType; Tab: React.ComponentType<{ terminalId: string | null; sessionId: string | null }>; Sheet: React.ComponentType; copy: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; reg: Record<string, any> };
function setup(docs: Record<string, unknown>[], fetchText?: (url: string) => string): Setup {
  useProjects.setState({ sessions: [{ id: 's1', name: 'Alpha' }] as never });
  const sdk = createPluginSdk('previews');
  const copy = vi.fn(async () => {});
  const set = vi.fn(async () => {});
  const reg: Record<string, any> = { views: [], inspectorTabs: [], projectMenu: [], slots: [] };
  if (fetchText) vi.stubGlobal('fetch', vi.fn(async (u: string) => ({ ok: true, status: 200, text: async () => fetchText(String(u)) })));
  const d = {
    ...sdk,
    ui: { ...sdk.ui, copyText: copy },
    docs: { ...sdk.docs, entries: vi.fn(async () => docs.map((v) => ({ key: `preview:${v.id}`, value: v }))), set },
    events: { on: () => () => {} },
    register: (c: Record<string, any[]>) => { for (const k of Object.keys(reg)) reg[k].push(...(c[k] ?? [])); },
  };
  activate(d as never);
  return { History: reg.views[0].Component, Tab: reg.inspectorTabs[0].Component, Sheet: reg.slots.find((s: { id: string }) => s.id === 'sheet').Component, copy, set, reg };
}
const card = (title: string) => screen.getByText(title).closest('[data-testid="preview-item"]') as HTMLElement;
afterEach(() => { vi.unstubAllGlobals(); });

describe('Drops: the name is one constant', () => {
  it('NAME is "Inbox", and the view, the tab and the project menu use it, with the tray icon', () => {
    const { reg } = setup([]);
    expect(NAME).toBe('Inbox');
    expect(reg.views[0].icon).toBe('tray');
    expect(reg.inspectorTabs[0].icon).toBe('tray');
    expect(reg.views[0].label).toBe(NAME);
    expect(reg.inspectorTabs[0].label).toBe(NAME);
    expect(reg.projectMenu[0].label).toBe(NAME);
  });

  it('the sheet title is "Inbox · <project>", and the empty text names the Inbox', async () => {
    const { Sheet, reg } = setup([]);
    render(<Sheet />);
    act(() => reg.projectMenu[0].onPick({ session: { id: 's1' } }));
    expect(await screen.findByText(`${NAME} · Alpha`)).toBeInTheDocument();
    expect(await screen.findByText(/Nothing here yet/)).toBeInTheDocument();
    // The empty view (2026-11-13): an icon, a title and one line, centred.
    const empty = screen.getByTestId('inbox-empty');
    expect(empty).toHaveTextContent('Threads in this project put commands, links, files and text here for you.');
    expect(empty.querySelector('svg')).not.toBeNull();
    expect(empty.style.alignItems).toBe('center');
  });
});

describe('Inbox: the model calls it the Inbox', () => {
  it('the tool description and the instructions say "your Inbox", never Drops', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.resolve(__dirname, '../../../plugins/previews');
    // The code, without its comments: the model reads the strings, not the history in the comments.
    const server = fs.readFileSync(path.join(dir, 'mcp/server.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const instr = fs.readFileSync(path.join(dir, 'instructions.md'), 'utf8');
    expect(server).toMatch(/your Inbox/);
    expect(instr).toMatch(/your Inbox/);
    expect(server + instr).not.toMatch(/Drops/);
  });
});

describe('Drops: kind inference (old drops have no kind)', () => {
  const f = (name: string, mime: string) => ({ fileId: name, name, mime, size: 10 });
  it('images only → images; files → files; a lone http(s) URL → link; markdown → doc; else text; a kind wins', () => {
    expect(inferKind({ files: [f('a.png', 'image/png'), f('b.jpg', 'image/jpeg')], text: null })).toBe('images');
    expect(inferKind({ files: [f('a.png', 'image/png'), f('r.pdf', 'application/pdf')], text: null })).toBe('files');
    expect(inferKind({ files: [], text: 'https://example.com/a?b=1' })).toBe('link');
    expect(inferKind({ files: [], text: '  http://localhost:3456  ' })).toBe('link');
    expect(inferKind({ files: [], text: 'https://a.com\nhttps://b.com' })).toBe('text');
    expect(inferKind({ files: [], text: 'javascript:alert(1)' })).toBe('text');
    expect(inferKind({ files: [], text: '# Title\n\n- a\n- b\n' })).toBe('doc');
    expect(inferKind({ files: [], text: './bin/dispatch update' })).toBe('text');
    expect(inferKind({ files: [], text: 'x', kind: 'code' })).toBe('code');
    expect(inferKind({ files: [], text: 'x', kind: 'not-a-kind' })).toBe('text');
  });

  it('each card carries a chip with the kind label, and the card its kind', async () => {
    const { History } = setup([
      base('a', { title: 'Shots', files: [f('a.png', 'image/png')] }),
      base('b', { title: 'Report', files: [f('r.pdf', 'application/pdf')] }),
      base('c', { title: 'Site', text: 'https://example.com' }),
      base('d', { title: 'Readme', text: '# Title\n\n- a\n- b\n' }),
      base('e', { title: 'Plain', text: 'hello there' }),
    ]);
    render(<History />);
    await screen.findByText('Shots');
    const chips = Object.fromEntries(['Shots', 'Report', 'Site', 'Readme', 'Plain'].map((t) => [t, within(card(t)).getByTestId('drop-kind').textContent]));
    expect(chips).toEqual({ Shots: 'Images', Report: 'Files', Site: 'Link', Readme: 'Doc', Plain: 'Text' });
    expect(card('Site').dataset.kind).toBe('link');
  });
});

describe('Drops: command', () => {
  it('each command has a $ row and its own Copy that copies exactly that command; Copy all copies them all', async () => {
    const commands = ['cd ~/Sites/dispatch', "git log --oneline -5 | grep 'fix(previews)'", './bin/dispatch update'];
    const { History, copy } = setup([base('c', { kind: 'command', title: 'Update', commands, text: commands.join('\n'), cwd: '~/Sites/dispatch' })]);
    render(<History />);
    await screen.findByText('Update');
    const c = card('Update');
    expect(within(c).getByTestId('drop-kind')).toHaveTextContent('Command');
    const rows = within(c).getAllByTestId('drop-command');
    expect(rows.map((r) => r.querySelector('code')!.textContent)).toEqual(commands);
    expect(rows.every((r) => r.textContent!.startsWith('$'))).toBe(true);
    expect(within(c).getByText('in ~/Sites/dispatch')).toBeInTheDocument();
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Copy command 2' }));
    await waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    expect(copy).toHaveBeenLastCalledWith("git log --oneline -5 | grep 'fix(previews)'");
    fireEvent.click(within(c).getByRole('button', { name: 'Copy all commands' }));
    await waitFor(() => expect(copy).toHaveBeenLastCalledWith(commands.join('\n')));
    // Long lines wrap: no sideways scroll on a phone.
    expect(rows[1].querySelector('code')!.style.whiteSpace).toBe('pre-wrap');
    expect(rows[1].querySelector('code')!.style.overflowWrap).toBe('anywhere');
  });

  it('one command has no Copy all; a command drop from text alone splits the lines', async () => {
    const { History } = setup([base('c', { kind: 'command', title: 'One', text: 'npm test' })]);
    render(<History />);
    await screen.findByText('One');
    expect(within(card('One')).getAllByTestId('drop-command')).toHaveLength(1);
    expect(within(card('One')).getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
    expect(within(card('One')).queryByRole('button', { name: 'Copy all commands' })).toBeNull();
  });
});

describe('Drops: link', () => {
  it('shows the host and the full URL, Open in a new tab (noopener) and Copy', async () => {
    const url = 'https://dash.cloudflare.com/abc/zero-trust/access/apps?filter=dispatch';
    const { History, copy } = setup([base('l', { kind: 'link', title: 'Access app', url, text: url })]);
    render(<History />);
    await screen.findByText('Access app');
    const c = card('Access app');
    expect(within(c).getByText('dash.cloudflare.com')).toBeInTheDocument();
    expect(within(c).getByTestId('drop-url')).toHaveTextContent(url);
    const open = within(c).getByRole('link', { name: 'Open link' });
    expect(open).toHaveAttribute('href', url);
    expect(open).toHaveAttribute('target', '_blank');
    expect(open.getAttribute('rel')).toContain('noopener');
    fireEvent.click(within(c).getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(url));
  });

  it('a stored url that is not http(s) gets no Open link', async () => {
    const { History } = setup([base('l', { kind: 'link', title: 'Bad', url: 'javascript:alert(1)', text: 'javascript:alert(1)' })]);
    render(<History />);
    await screen.findByText('Bad');
    expect(within(card('Bad')).queryByRole('link', { name: 'Open link' })).toBeNull();
  });
});

describe('Drops: code, diff, steps', () => {
  it('code: a mono block with a language chip and Copy', async () => {
    const { History, copy } = setup([base('k', { kind: 'code', title: 'Snippet', text: 'const a = 1;\nconsole.log(a);', language: 'ts' })]);
    render(<History />);
    await screen.findByText('Snippet');
    const c = card('Snippet');
    expect(within(c).getByTestId('drop-code')).toHaveTextContent('const a = 1;');
    expect(within(c).getByTestId('drop-language')).toHaveTextContent('ts');
    fireEvent.click(within(c).getByRole('button', { name: 'Copy code' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith('const a = 1;\nconsole.log(a);'));
  });

  it('diff: + lines, - lines and @@ lines are marked; Copy copies the diff', async () => {
    const diff = '--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n keep';
    const { History, copy } = setup([base('d', { kind: 'diff', title: 'Change', text: diff })]);
    render(<History />);
    await screen.findByText('Change');
    const lines = [...within(card('Change')).getByTestId('drop-diff').querySelectorAll('[data-line]')].map((l) => [l.getAttribute('data-line'), l.textContent]);
    expect(lines).toEqual([['file', '--- a/x.ts'], ['file', '+++ b/x.ts'], ['hunk', '@@ -1,2 +1,2 @@'], ['del', '-const a = 1;'], ['add', '+const a = 2;'], ['ctx', ' keep']]);
    fireEvent.click(within(card('Change')).getByRole('button', { name: 'Copy diff' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(diff));
  });

  it('steps: a numbered list; a step with a command has its own Copy', async () => {
    const steps = [{ text: 'Open Settings → Plugins' }, { text: 'Update the daemon', command: './bin/dispatch update' }];
    const { History, copy } = setup([base('s', { kind: 'steps', title: 'How to', steps, text: '1. x' })]);
    render(<History />);
    await screen.findByText('How to');
    const list = within(card('How to')).getByTestId('drop-steps');
    expect(list.tagName).toBe('OL');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Open Settings → Plugins');
    expect(within(items[0]).queryByRole('button')).toBeNull();
    fireEvent.click(within(items[1]).getByRole('button', { name: 'Copy command for step 2' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith('./bin/dispatch update'));
  });
});

describe('Drops: secret', () => {
  it('is masked (•••• and the last 4), Reveal shows it, Copy copies the real value; never in the title or the list text', async () => {
    const { History, copy } = setup([base('x', { kind: 'secret', title: 'API token', text: SECRET })]);
    const { container } = render(<History />);
    await screen.findByText('API token');
    const c = card('API token');
    expect(within(c).getByTestId('drop-secret')).toHaveTextContent('••••1234');
    expect(container.textContent).not.toContain(SECRET);
    expect(container.innerHTML).not.toContain(SECRET);
    const reveal = within(c).getByRole('button', { name: 'Reveal secret' });
    fireEvent.click(reveal);
    expect(within(c).getByTestId('drop-secret')).toHaveTextContent(SECRET);
    expect(within(c).getByRole('button', { name: 'Hide secret' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(c).getByRole('button', { name: 'Hide secret' }));
    expect(container.textContent).not.toContain(SECRET);
    fireEvent.click(within(c).getByRole('button', { name: 'Copy secret' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(SECRET));
  });

  it('maskSecret: the last 4 only for a long value', () => {
    expect(maskSecret(SECRET)).toBe('••••1234');
    expect(maskSecret('short')).toBe('••••••••');
  });

  it('the search never matches the secret value', () => {
    const items = [base('x', { kind: 'secret', title: 'Secret', text: SECRET }), base('y', { title: 'Other', text: 'sk-live-elsewhere' })];
    expect(filterPreviews(items as never, { query: '4f9a8b7c' })).toEqual([]);
    expect(filterPreviews(items as never, { query: 'secret' }).map((p: { id: string }) => p.id)).toEqual(['x']);
  });

  it('a secret older than 24 hours loses its text when the list loads, and the card says it expired', async () => {
    const old = base('x', { kind: 'secret', title: 'Old token', text: SECRET, createdAt: new Date(NOW - 25 * 3_600_000).toISOString() });
    const fresh = base('y', { kind: 'secret', title: 'New token', text: 'tok-fresh-99998888', createdAt: new Date(NOW - 3_600_000).toISOString() });
    const { History, set } = setup([old, fresh]);
    const { container } = render(<History />);
    await screen.findByText('Old token');
    await waitFor(() => expect(set).toHaveBeenCalledWith('preview:x', expect.objectContaining({ text: null, expired: true })));
    expect(set).not.toHaveBeenCalledWith('preview:y', expect.anything());
    expect(within(card('Old token')).getByText(/This secret expired/)).toBeInTheDocument();
    expect(within(card('Old token')).queryByRole('button', { name: 'Copy secret' })).toBeNull();
    expect(container.textContent).not.toContain(SECRET);
    expect(within(card('New token')).getByRole('button', { name: 'Copy secret' })).toBeInTheDocument();
  });
});

describe('Drops: table', () => {
  it('parseCsv reads quotes, commas and new lines in quotes', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n1,"two\nlines"\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['1', 'two\nlines']]);
  });

  it('CSV text: a header row (sticky), the first 50 rows, and "+N more rows"', async () => {
    const csv = ['name,qty', ...Array.from({ length: 60 }, (_, i) => `item ${i},${i}`)].join('\n');
    const { History } = setup([base('t', { kind: 'table', title: 'Stock', text: csv })]);
    render(<History />);
    await screen.findByText('Stock');
    const table = within(card('Stock')).getByTestId('drop-table');
    const th = table.querySelectorAll('thead th');
    expect([...th].map((x) => x.textContent)).toEqual(['name', 'qty']);
    expect((th[0] as HTMLElement).style.position).toBe('sticky');
    expect(table.querySelectorAll('tbody tr')).toHaveLength(50);
    expect(within(card('Stock')).getByText('+10 more rows')).toBeInTheDocument();
  });

  it('a .json file: an array of objects becomes columns', async () => {
    const files = [{ fileId: 'f1', name: 'rows.json', mime: 'application/json', size: 40 }];
    const { History } = setup([base('t', { kind: 'table', title: 'Rows', files })], () => JSON.stringify([{ a: 1, b: 'x' }, { a: 2, c: true }]));
    render(<History />);
    await screen.findByText('Rows');
    const table = await within(card('Rows')).findByTestId('drop-table');
    expect([...table.querySelectorAll('thead th')].map((x) => x.textContent)).toEqual(['a', 'b', 'c']);
    expect([...table.querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent))).toEqual([['1', 'x', ''], ['2', '', 'true']]);
  });
});

describe('Drops: images open the viewer with the quick copy first', () => {
  it('the viewer gets the 480 copy as placeholder and the 1600 copy as display; src stays the original', async () => {
    const files = [{ fileId: 'img1', name: 'shot.png', mime: 'image/png', size: 1_900_000 }];
    const { History } = setup([base('i', { title: 'Shot', files })]);
    render(<History />);
    await screen.findByText('Shot');
    fireEvent.click(within(card('Shot')).getByRole('button', { name: 'Open shot.png' }));
    const img = await screen.findByRole('img', { name: 'shot.png' });
    expect(img.getAttribute('src')).toMatch(/\/files\/img1\?thumb=480$/);
    expect(document.querySelector('img[data-viewer-preload]')!.getAttribute('src')).toMatch(/\/files\/img1\?thumb=1600$/);
    expect(screen.getByRole('link', { name: 'Open the original' }).getAttribute('href')).toMatch(/\/files\/img1$/);
  });
});

describe('Drops: the thread tab renders the kinds too', () => {
  it('a command drop in the thread tab has its Copy buttons', async () => {
    const { Tab } = setup([base('c', { kind: 'command', title: 'Run it', commands: ['make', 'make test'], text: 'make\nmake test' })]);
    render(<Tab terminalId="t1" sessionId="s1" />);
    await screen.findByText('Run it');
    expect(screen.getAllByRole('button', { name: /^Copy command \d$/ })).toHaveLength(2);
  });
});

// Owner rule (2026-11-11): no coloured or grey left-edge stripe on any card or block; the chip alone tells the kind.
describe('Drops: no left-edge stripes', () => {
  it('no card or block has a left border or an inset shadow', async () => {
    const { History } = setup([
      base('a', { kind: 'command', title: 'C', commands: ['ls'], text: 'ls' }),
      base('b', { kind: 'diff', title: 'D', text: '+x\n-y' }),
      base('c', { kind: 'code', title: 'K', text: 'x' }),
      base('d', { kind: 'steps', title: 'S', steps: [{ text: 'a', command: 'b' }] }),
    ]);
    const { container } = render(<History />);
    await screen.findByText('C');
    for (const el of container.querySelectorAll<HTMLElement>('*')) {
      expect(el.style.borderLeft, el.outerHTML.slice(0, 80)).toBe('');
      expect(el.style.borderLeftWidth).toBe('');
      expect(el.style.boxShadow).not.toMatch(/inset/);
    }
  });
});
