import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { ConvItem } from '../../../api/types';
import { ChatView } from './ChatView';
import { api } from '../../../api/client';
import { useDocViewer } from '../../../stores/docViewer';
import { useProjects } from '../../../stores/projects';
import { useTabs } from '../../../stores/tabs';
import { useUI } from '../../../stores/ui';
import * as fileTab from '../../../lib/openFileTab';
import * as saveFiles from '../../../lib/saveFiles';

let items: ConvItem[] = [];
vi.mock('./useStructuredChat', async (orig) => ({
  ...(await orig<typeof import('./useStructuredChat')>()),
  useStructuredChat: () => ({
    items, busy: false, send: () => {}, pending: null, answer: () => {}, compacting: false, compactResult: null,
    apiRetry: null, compact: () => {}, hasMore: false, loadingOlder: false, loadOlder: () => {},
  }),
}));

beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
});

const FOLDER = '/Users/me/dev/app';
const say = (text: string): ConvItem[] => [{ kind: 'assistant', text } as ConvItem];

function mount(type: string) {
  useProjects.setState({ sessions: [{ id: 's1', name: 'app', workingDir: FOLDER }] as any });
  useTabs.setState({ byProject: { s1: [{ id: 't1', sessionId: 's1', type, label: 'x' }] } as any });
  vi.spyOn(api, 'getResumeAdvice').mockResolvedValue({ shouldPrompt: false, ageMinutes: 0, contextTokens: 0 });
  return render(<ChatView terminalId="t1" />);
}

beforeEach(() => { useDocViewer.getState().close(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('a reconnect remounts the thread view', () => {
  it('keeps the doc the reader has open', () => {
    items = say('hi');
    const a = mount('codex');
    useDocViewer.getState().show({ project: 's1', path: 'docs/a.md', branch: null, origin: 't1' });
    a.unmount();
    expect(useDocViewer.getState().open).not.toBeNull();
  });
});

describe.each(['claude-code', 'codex', 'grok', 'opencode'])('a %s thread', (type) => {
  it('opens a Codex-style markdown link to a doc in the doc viewer, in place', async () => {
    items = say(`See [plan.md](${FOLDER}/docs/plans/plan.md:12) for the steps.`);
    vi.spyOn(api, 'endlessDoc').mockReturnValue(new Promise(() => {}));
    mount(type);
    const before = window.location.href;
    expect(fireEvent.click(await screen.findByRole('link', { name: 'plan.md', hidden: true }))).toBe(false);
    expect(useDocViewer.getState().open).toMatchObject({ project: 's1', path: `${FOLDER}/docs/plans/plan.md` });
    expect(screen.getByRole('dialog', { name: 'plan.md', hidden: true })).toBeInTheDocument();
    expect(window.location.href).toBe(before);
  });

  it('shows a Claude-style bare doc path as a chip that opens the doc', async () => {
    items = say(`I wrote the design to ${FOLDER}/docs/specs/design.md and \`docs/specs/other.md\`.`);
    vi.spyOn(api, 'endlessDoc').mockReturnValue(new Promise(() => {}));
    mount(type);
    await screen.findByText('I wrote the design to', { exact: false });
    const chips = document.querySelectorAll<HTMLElement>('.doc-chip');
    expect(chips).toHaveLength(2);
    fireEvent.click(chips[1]);
    expect(useDocViewer.getState().open).toMatchObject({ project: 's1', path: 'docs/specs/other.md' });
  });

  it('opens web links in a new tab and does nothing for a file outside the project', async () => {
    items = say('[site](https://example.com/x) [mail](mailto:a@b.co) [out](/etc/hosts.md) [code](' + FOLDER + '/src/a.ts)');
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    mount(type);
    await screen.findByRole('link', { name: 'site', hidden: true });
    for (const n of ['site', 'mail']) expect(fireEvent.click(screen.getByRole('link', { name: n, hidden: true }))).toBe(false);
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener,noreferrer');
    for (const n of ['out', 'code']) expect(fireEvent.click(screen.getByRole('link', { name: n, hidden: true }))).toBe(false);
    expect(open).toHaveBeenCalledTimes(2);
    expect(useDocViewer.getState().open).toBeNull();
  });
});

describe('file chips in a thread reply (any file type)', () => {
  it('a code path is a chip; a click opens a file tab and brings it to front', async () => {
    items = say('I wrote `scripts/extract.py` and data/out.xlsx, see also https://example.com/a.html and v3.19.0.');
    const tab = vi.spyOn(fileTab, 'openFileTab').mockResolvedValue('ft1');
    const save = vi.spyOn(saveFiles, 'saveFileAs').mockResolvedValue();
    mount('claude-code');
    await screen.findByText('I wrote', { exact: false });
    const chips = document.querySelectorAll<HTMLElement>('.doc-chip');
    expect([...chips].map((c) => c.textContent)).toEqual(['extract.py', 'out.xlsx']);
    fireEvent.click(chips[0]);
    expect(tab).toHaveBeenCalledWith('s1', 'scripts/extract.py', { focus: true });
    expect(useDocViewer.getState().open).toBeNull();
    fireEvent.click(chips[1]);
    expect(save).toHaveBeenCalledWith('/api/sessions/s1/files/download?path=data%2Fout.xlsx', 'out.xlsx');
    expect(useUI.getState().pendingOpenThread).toBeNull();
  });
  it('an absolute path opens as the path inside the project; a path that leaves it is no chip', async () => {
    items = say(`Wrote ${FOLDER}/scripts/run.py, and ${FOLDER}/../other/x.py, and ../y.py`);
    const tab = vi.spyOn(fileTab, 'openFileTab').mockResolvedValue('ft1');
    mount('codex');
    await screen.findByText('Wrote', { exact: false });
    const chips = document.querySelectorAll<HTMLElement>('.doc-chip');
    expect([...chips].map((c) => c.textContent)).toEqual(['run.py']);
    fireEvent.click(chips[0]);
    expect(tab).toHaveBeenCalledWith('s1', 'scripts/run.py', { focus: true });
  });
});
