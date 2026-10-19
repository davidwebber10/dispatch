import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { DocViewer, editorUrl } from './DocViewer';
import { ChatImage } from '../ChatImage';
import { useDocViewer } from '../../stores/docViewer';
import { useHost } from '../../stores/host';
import { useSettings } from '../../stores/settings';
import { useEndless } from '../../stores/endless';
import { api } from '../../api/client';

const copy = (o = {}) => ({ project: 's1', path: 'docs/specs/x.md', absPath: '/w/d/.worktrees/x/docs/specs/x.md', source: 'worktree', worktree: 'x', branch: 'spec/x', vsMain: 'not_on_main', modifiedAt: '2026-10-19T11:31:00Z', status: 'draft', note: null, markdown: '# X\n\nSee docs/specs/y.md', ...o });
// The API client's own message format (api/client.ts `req`).
const failed = (status: number, detail = '') => new Error(`GET /api/endless/doc?project=s1&path=docs%2Fspecs%2Fx.md failed: ${status}${detail ? ` — ${detail}` : ''}`);

beforeEach(() => {
  useDocViewer.setState({ open: { project: 's1', path: 'docs/specs/x.md', branch: null }, back: [] });
  useHost.setState({ canReveal: true } as any);
  useEndless.setState({ projects: [{ id: 's1', name: 'dispatch', folder: '/w/d', live: 0, needsYou: 0, openItems: 0, lastReport: null, messages: 0 }] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); useSettings.setState({ editor: '' } as any); });

describe('DocViewer', () => {
  it('renders nothing when no doc is open', () => {
    useDocViewer.setState({ open: null, back: [] });
    const spy = vi.spyOn(api, 'endlessDoc');
    render(<DocViewer />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });
  it('shows the location and vs-main chips, the status line and the doc', async () => {
    vi.spyOn(api, 'endlessDoc').mockResolvedValue(copy() as any);
    render(<DocViewer />);
    expect(await screen.findByText('worktree x on spec/x')).toBeInTheDocument();
    expect(screen.getByText('not on main')).toBeInTheDocument();
    expect(screen.getByText('draft')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'X' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'x.md' })).toBeInTheDocument();
  });
  it('a branch copy says as of the last fetch, and has no Reveal', async () => {
    vi.spyOn(api, 'endlessDoc').mockResolvedValue(copy({ source: 'branch', absPath: null, worktree: null, branch: 'origin/spec/t', vsMain: 'changed' }) as any);
    render(<DocViewer />);
    expect(await screen.findByText('branch origin/spec/t, as of the last fetch')).toBeInTheDocument();
    expect(screen.getByText('changed here')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reveal in Finder' })).not.toBeInTheDocument();
  });
  it('a main copy says main and on main; an unknown comparison has no chip', async () => {
    vi.spyOn(api, 'endlessDoc').mockResolvedValue(copy({ source: 'main', worktree: null, branch: null, vsMain: 'unknown' }) as any);
    render(<DocViewer />);
    expect(await screen.findByText('main')).toBeInTheDocument();
    expect(screen.queryByText('on main')).not.toBeInTheDocument();
    expect(screen.queryByText('not on main')).not.toBeInTheDocument();
  });
  it('Reveal and Open in editor need canReveal; the editor needs a setting', async () => {
    vi.spyOn(api, 'endlessDoc').mockResolvedValue(copy() as any);
    useSettings.setState({ editor: '' } as any);
    const { unmount } = render(<DocViewer />);
    expect(await screen.findByRole('button', { name: 'Reveal in Finder' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in editor' })).not.toBeInTheDocument();
    unmount();
    useSettings.setState({ editor: 'vscode' } as any);
    const second = render(<DocViewer />);
    expect(await screen.findByRole('button', { name: 'Open in editor' })).toBeInTheDocument();
    second.unmount();
    useHost.setState({ canReveal: false } as any);
    render(<DocViewer />);
    await screen.findByText('not on main');
    expect(screen.queryByRole('button', { name: 'Reveal in Finder' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in editor' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy path' })).toBeInTheDocument();
  });
  it('Reveal sends the path relative to the project folder', async () => {
    vi.spyOn(api, 'endlessDoc').mockResolvedValue(copy() as any);
    const reveal = vi.spyOn(api, 'revealFiles').mockResolvedValue({ ok: true });
    render(<DocViewer />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal in Finder' }));
    await waitFor(() => expect(reveal).toHaveBeenCalledWith('s1', ['.worktrees/x/docs/specs/x.md']));
  });
  it('Copy path copies the absolute path, or branch:path for a branch copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.spyOn(api, 'endlessDoc').mockResolvedValueOnce(copy({ source: 'branch', absPath: null, worktree: null, branch: 'origin/spec/t' }) as any);
    render(<DocViewer />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy path' }));
    expect(await screen.findByText('Copied.')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith('origin/spec/t:docs/specs/x.md');
  });
  it('not found, refused, too large', async () => {
    vi.spyOn(api, 'endlessDoc').mockRejectedValueOnce(failed(404));
    const { unmount } = render(<DocViewer />);
    expect(await screen.findByText('This file is not in the project, its worktrees or its branches.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy path' })).toBeInTheDocument();
    unmount();
    vi.spyOn(api, 'endlessDoc').mockRejectedValueOnce(failed(403));
    const second = render(<DocViewer />);
    expect(await screen.findByText('This path is outside the project.')).toBeInTheDocument();
    second.unmount();
    vi.spyOn(api, 'endlessDoc').mockRejectedValueOnce(failed(413));
    render(<DocViewer />);
    expect(await screen.findByText('This file is larger than 2 MB, so it does not open here.')).toBeInTheDocument();
  });
  it('a link inside the doc opens the next doc, and Back returns', async () => {
    vi.spyOn(api, 'endlessDoc').mockResolvedValue(copy() as any);
    render(<DocViewer />);
    fireEvent.click(await screen.findByRole('button', { name: 'y.md' }));
    expect(useDocViewer.getState().open?.path).toBe('docs/specs/y.md');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(useDocViewer.getState().open?.path).toBe('docs/specs/x.md'));
  });
  it('a relative link in a copy keeps the open copy; an absolute link and a main copy do not', async () => {
    const spy = vi.spyOn(api, 'endlessDoc').mockResolvedValue(copy() as any);
    const { unmount } = render(<DocViewer />);
    fireEvent.click(await screen.findByRole('button', { name: 'y.md' }));
    expect(useDocViewer.getState().open).toMatchObject({ path: 'docs/specs/y.md', worktree: 'x' });
    unmount();
    useDocViewer.setState({ open: { project: 's1', path: 'docs/specs/x.md', branch: null }, back: [] });
    spy.mockResolvedValue(copy({ markdown: 'See /w/d/docs/specs/y.md' }) as any);
    const second = render(<DocViewer />);
    fireEvent.click(await screen.findByRole('button', { name: 'y.md' }));
    expect(useDocViewer.getState().open?.worktree ?? null).toBeNull();
    expect(useDocViewer.getState().open?.branch ?? null).toBeNull();
    second.unmount();
    useDocViewer.setState({ open: { project: 's1', path: 'docs/specs/x.md', branch: null }, back: [] });
    spy.mockResolvedValue(copy({ source: 'main', worktree: null, branch: null }) as any);
    render(<DocViewer />);
    fireEvent.click(await screen.findByRole('button', { name: 'y.md' }));
    expect(useDocViewer.getState().open?.worktree ?? null).toBeNull();
    expect(useDocViewer.getState().open?.branch ?? null).toBeNull();
  });
  it('a relative link in a branch copy keeps the branch', async () => {
    vi.spyOn(api, 'endlessDoc').mockResolvedValue(copy({ source: 'branch', absPath: null, worktree: null, branch: 'spec/t' }) as any);
    render(<DocViewer />);
    fireEvent.click(await screen.findByRole('button', { name: 'y.md' }));
    expect(useDocViewer.getState().open).toMatchObject({ path: 'docs/specs/y.md', branch: 'spec/t' });
  });
  it('Close and Escape close the viewer', async () => {
    vi.spyOn(api, 'endlessDoc').mockResolvedValue(copy() as any);
    const { unmount } = render(<DocViewer />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(useDocViewer.getState().open).toBeNull();
    unmount();
    useDocViewer.setState({ open: { project: 's1', path: 'docs/specs/x.md', branch: null }, back: [] });
    render(<DocViewer />);
    await screen.findByText('not on main');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useDocViewer.getState().open).toBeNull();
  });
  it('passes the worktree name of the ref to the API', async () => {
    useDocViewer.setState({ open: { project: 's1', path: 'docs/specs/x.md', branch: null, worktree: 'x' }, back: [] });
    const spy = vi.spyOn(api, 'endlessDoc').mockResolvedValue(copy() as any);
    render(<DocViewer />);
    await screen.findByText('not on main');
    expect(spy).toHaveBeenCalledWith('s1', 'docs/specs/x.md', null, 'x');
  });
  it('the editor URL encodes each path segment', () => {
    expect(editorUrl('vscode', '/w/a#b?.md')).toBe('vscode://file/w/a%23b%3F.md');
    expect(editorUrl('cursor', '/w/my doc/é.md')).toBe('cursor://file/w/my%20doc/%C3%A9.md');
    expect(editorUrl('zed', '/w/100%/x.md')).toBe('zed://file/w/100%25/x.md');
  });
  it('Open in editor clicks a temporary link (no page navigation) with the encoded URL', async () => {
    vi.spyOn(api, 'endlessDoc').mockResolvedValue(copy({ absPath: '/w/d/a#b?.md' }) as any);
    useSettings.setState({ editor: 'vscode' } as any);
    const hrefs: (string | null)[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { hrefs.push(this.getAttribute('href')); expect(this.isConnected).toBe(true); });
    const before = window.location.href;
    render(<DocViewer />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open in editor' }));
    expect(hrefs).toEqual(['vscode://file/w/d/a%23b%3F.md']);
    expect(window.location.href).toBe(before);
    expect(document.querySelector('a[href^="vscode:"]')).toBeNull();
  });
  it('a path that is not absolute has no Open in editor', async () => {
    vi.spyOn(api, 'endlessDoc').mockResolvedValue(copy({ absPath: 'w/d/x.md' }) as any);
    useSettings.setState({ editor: 'vscode' } as any);
    render(<DocViewer />);
    await screen.findByText('not on main');
    expect(screen.queryByRole('button', { name: 'Open in editor' })).not.toBeInTheDocument();
  });
  it('Escape that another handler already took does not close; a close takes the key', async () => {
    vi.spyOn(api, 'endlessDoc').mockResolvedValue(copy() as any);
    render(<DocViewer />);
    await screen.findByText('not on main');
    const take = (e: Event) => e.preventDefault();
    document.body.addEventListener('keydown', take);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useDocViewer.getState().open).not.toBeNull();
    document.body.removeEventListener('keydown', take);
    expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(false);
    expect(useDocViewer.getState().open).toBeNull();
  });
  it('Escape over an image lightbox inside the viewer closes only the image', async () => {
    vi.spyOn(api, 'endlessDoc').mockResolvedValue(copy() as any);
    render(<><DocViewer /><ChatImage src="/a.png" alt="chart" /></>);
    await screen.findByText('not on main');
    fireEvent.click(screen.getByAltText('chart'));
    expect(screen.getByRole('dialog', { name: 'chart' })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'chart' })).toBeNull();
    expect(useDocViewer.getState().open).not.toBeNull();
  });
});

describe('DocViewer: links inside the doc stay in the viewer', () => {
  const show = async (markdown: string, o = {}) => {
    vi.spyOn(api, 'endlessDoc').mockResolvedValue(copy({ markdown, ...o }) as any);
    render(<DocViewer />);
    await screen.findByText('not on main');
  };
  it('a relative doc link opens that doc from the open doc\'s folder, in the same copy', async () => {
    await show('[y](./y.md)');
    expect(fireEvent.click(screen.getByRole('link', { name: 'y' }))).toBe(false);
    expect(useDocViewer.getState().open).toMatchObject({ project: 's1', path: 'docs/specs/y.md', worktree: 'x' });
    expect(useDocViewer.getState().back).toHaveLength(1);
  });
  it('a ../ link resolves against the folder; a #fragment is dropped', async () => {
    await show('[up](../plans/z.md#part)');
    fireEvent.click(screen.getByRole('link', { name: 'up' }));
    expect(useDocViewer.getState().open).toMatchObject({ path: 'docs/plans/z.md' });
  });
  it('a ?query is dropped too', async () => {
    await show('[q](y.markdown?v=1)');
    fireEvent.click(screen.getByRole('link', { name: 'q' }));
    expect(useDocViewer.getState().open).toMatchObject({ path: 'docs/specs/y.markdown' });
  });
  it('a web link opens in a new tab and the app does not navigate', async () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    const before = window.location.href;
    await show('[ext](https://example.com)');
    expect(fireEvent.click(screen.getByRole('link', { name: 'ext' }))).toBe(false);
    expect(opened).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener');
    expect(window.location.href).toBe(before);
    expect(useDocViewer.getState().open?.path).toBe('docs/specs/x.md');
  });
  it('a relative link that leads above the repo root does nothing', async () => {
    useDocViewer.setState({ open: { project: 's1', path: 'docs/x.md', branch: null }, back: [] });
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    await show('[bad](../../../x.md)', { path: 'docs/x.md' });
    expect(fireEvent.click(screen.getByRole('link', { name: 'bad' }))).toBe(false);
    expect(useDocViewer.getState().open).toMatchObject({ path: 'docs/x.md' });
    expect(useDocViewer.getState().back).toHaveLength(0);
    expect(opened).not.toHaveBeenCalled();
  });
});
