import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { DocViewer } from './DocViewer';
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
});
