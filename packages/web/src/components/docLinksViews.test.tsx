// Doc links in every view that shows message text or markdown (the Chat tab was the only one wired).
// Each view gets three links: a .md path (opens the doc viewer for that view), an http link (a new tab)
// and an app-host link with an absolute path (`http://localhost:3456/Users/...`, read as the file).
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi, type MockInstance } from 'vitest';

vi.mock('./overseer/components/Composer', () => ({ Composer: () => <div data-testid="composer-stub" /> }));
vi.mock('./overseer/store', async (orig) => ({ ...(await orig<typeof import('./overseer/store')>()), useCoordinatorSync: () => {}, useNeedsSync: () => {} }));
vi.mock('./overseer/components/WorkerLightbox', () => ({ WorkerLightbox: () => null }));

import { Markdown } from './Markdown';
import { OverseerView } from './overseer/OverseerView';
import { useOverseer } from './overseer/store';
import { useLedgerCard } from '../stores/ledgerCard';
import { ChatMode } from './endless/ChatMode';
import { useEndless } from '../stores/endless';
import { FileEditorTab } from './tabs/FileEditorTab';
import { WebView } from './tabs/toolviews/WebView';
import { ReleaseNotes } from './update/ReleaseNotes';
import { useDocViewer } from '../stores/docViewer';
import { useProjects } from '../stores/projects';
import { api } from '../api/client';
import { m } from './overseer/data';

vi.mock('codemirror', () => ({ EditorView: class { state = { doc: { toString: () => '' } }; destroy() {} static updateListener = { of: () => ({}) }; }, basicSetup: [] }));
vi.mock('@codemirror/state', () => ({ EditorState: { create: () => ({}) } }));
vi.mock('@codemirror/theme-one-dark', () => ({ oneDark: {} }));

const DOC = '/Users/me/dev/app/docs/plan.md';
const SRC = `[plan](${DOC}) [web](https://example.com/x) [local](http://localhost:3456${DOC})`;
const click = (name: string) => fireEvent.click(screen.getByText(name));

let open: MockInstance<typeof window.open>;
beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
  Element.prototype.scrollTo = Element.prototype.scrollTo || (() => {});
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
});
beforeEach(() => {
  open = vi.spyOn(window, 'open').mockReturnValue(null);
  vi.spyOn(api, 'endlessDoc').mockReturnValue(new Promise(() => {}));
  useProjects.setState({ sessions: [{ id: 'p1', workingDir: '/Users/me/dev/app' }], activeId: 'p1' } as never);
  useDocViewer.setState({ open: null, back: [] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** A doc link opens the viewer owned by `origin`, a web link opens a new tab, and no click navigates. */
function expectRouted(origin: string | undefined) {
  expect(click('plan')).toBe(false);
  expect(useDocViewer.getState().open).toMatchObject({ project: 'p1', path: DOC, origin });
  act(() => useDocViewer.getState().close());
  expect(click('local')).toBe(false);
  expect(useDocViewer.getState().open).toMatchObject({ project: 'p1', path: DOC, origin });
  expect(open).not.toHaveBeenCalled();
  expect(click('web')).toBe(false);
  expect(open).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener,noreferrer');
}

describe('a Markdown with no view around it (release notes, any new surface)', () => {
  it('never navigates the app: a web link opens a new tab, a path link does nothing', () => {
    render(<Markdown source={SRC} />);
    expect(click('plan')).toBe(false);
    expect(click('local')).toBe(false);
    expect(useDocViewer.getState().open).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(click('web')).toBe(false);
    expect(open).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener,noreferrer');
  });
  it('ReleaseNotes: a link in a note opens a new tab', () => {
    render(<ReleaseNotes notes={[{ version: 'v9.9.9', url: 'https://example.com/v9.9.9', publishedAt: '2026-08-01T00:00:00Z', notes: '# Dispatch v9.9.9: x\n\nThe change [web](https://example.com/x).' }]} />);
    fireEvent.click(screen.getByText('Release notes'));
    fireEvent.click(screen.getByText('Full notes'));
    expect(click('web')).toBe(false);
    expect(open).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener,noreferrer');
  });
});

describe('the overseer (Control Plane)', () => {
  beforeEach(() => {
    useOverseer.setState({ coordinatorId: 'c1', coordinatorProject: 'p1', coordinatorStream: [m('overseer', 'Control Plane', SRC, '9:02', 1)], coordinatorBusy: false, coordinatorPending: null } as never);
  });
  it('a link in an overseer reply opens the overseer\'s own doc viewer', () => {
    render(<OverseerView />);
    expectRouted('overseer');
  });
  it('a link in the ledger source panel does too', async () => {
    vi.spyOn(api, 'getLedgerSource').mockResolvedValue({ kind: 'section', file: 'r.md', path: 'docs/r.md', heading: 'H', markdown: SRC, id: 'LR-6', fromMainCheckout: false, note: null, cut: false } as never);
    useOverseer.setState({ coordinatorStream: [] } as never);
    useLedgerCard.setState({ sourcePanel: { projectId: 'p1', seq: 14 } } as never);
    render(<OverseerView />);
    await screen.findByText('plan');
    expectRouted('overseer');
  });
});

describe('the Chat page', () => {
  it('a link in the live reply opens Chat\'s own doc viewer', () => {
    vi.spyOn(api, 'endlessProjects').mockResolvedValue({ projects: [], threads: [], truncated: false } as never);
    vi.spyOn(api, 'endlessMessages').mockResolvedValue({ messages: [], hasMore: false, hasMoreAfter: false } as never);
    vi.spyOn(api, 'endlessState').mockResolvedValue({ turn: { status: 'idle', error: null } } as never);
    useEndless.setState({ loaded: true, liveText: SRC, turn: { status: 'running', error: null } } as never);
    render(<ChatMode />);
    expectRouted(undefined);
  });
});

describe('a markdown file tab', () => {
  it('a link in the preview opens a doc viewer for the tab', async () => {
    vi.spyOn(api, 'readFile').mockResolvedValue({ content: SRC, path: 'a.md' } as never);
    render(<FileEditorTab terminal={{ id: 'tab1', sessionId: 'p1', type: 'file', label: 'a.md', config: { path: 'a.md' } } as never} />);
    await screen.findByText('plan');
    expectRouted('tab1');
  });
});

describe('a web tool result', () => {
  it('never navigates the app', () => {
    render(<WebView tool={{ toolInput: '{}' } as never} result={{ text: SRC } as never} />);
    expect(click('plan')).toBe(false);
    expect(click('local')).toBe(false);
    expect(click('web')).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
