import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { ConvItem } from '../../../api/types';
import { ChatView } from './ChatView';
import { api } from '../../../api/client';
import { useDocViewer } from '../../../stores/docViewer';
import { useProjects } from '../../../stores/projects';
import { useTabs } from '../../../stores/tabs';

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
