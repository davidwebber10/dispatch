import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { DiffReview } from './DiffReview';
import { api } from '../../api/client';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import type { DiffFile, ThreadDiff } from '../../api/types';
import { pickOption } from '../../test/select';

const FILES: DiffFile[] = [
  { path: 'src/app.ts', status: 'modified', additions: 3, deletions: 1, staged: false, patch: '@@ -1,2 +1,4 @@\n one\n-two\n+TWO\n+three\n+four\n' },
  { path: 'notes/new.md', status: 'untracked', additions: 2, deletions: 0, staged: false, patch: '@@ -0,0 +1,2 @@\n+hello\n+world\n' },
  { path: 'old.txt', status: 'deleted', additions: 0, deletions: 5, staged: true, patch: '@@ -1,5 +0,0 @@\n-a\n-b\n-c\n-d\n-e\n' },
  { path: 'logo.png', status: 'modified', additions: 0, deletions: 0, staged: false, binary: true },
];
const diff = (over: Partial<ThreadDiff> = {}): ThreadDiff => ({ files: FILES, truncated: false, shared: false, repo: true, branch: 'dispatch/side', workDir: '/repo/.claude/worktrees/side', ...over });

let confirmSpy: { mock: { calls: unknown[][] } };

beforeEach(() => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'proj', workingDir: '/repo' }] } as any);
  useTabs.setState({ byProject: { p1: [] } } as any);
  vi.spyOn(api, 'getThreadDiff').mockResolvedValue(diff());
  vi.spyOn(api, 'approveChanges').mockResolvedValue({ staged: [] });
  vi.spyOn(api, 'discardChanges').mockResolvedValue({ discarded: [{ path: 'src/app.ts', backup: 'abc1234def5678' }], errors: [] });
  vi.spyOn(api, 'listWorktrees').mockResolvedValue({ worktrees: [] });
  vi.spyOn(api, 'removeWorktree').mockResolvedValue({ removed: true, path: '/repo/.claude/worktrees/old', branch: 'dispatch/old' });
  vi.spyOn(api, 'getGitStatus').mockResolvedValue({ branch: 'main', files: [] });
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

const row = (path: string) => screen.getByTestId(`diff-file-${path}`);

describe('DiffReview', () => {
  it('shows the files with counts', async () => {
    render(<DiffReview projectId="p1" terminalId="t1" />);
    await screen.findByText('src/app.ts');
    expect(api.getThreadDiff).toHaveBeenCalledWith('p1', 't1');
    expect(within(row('src/app.ts')).getByText('+3')).toBeInTheDocument();
    expect(within(row('src/app.ts')).getByText('-1')).toBeInTheDocument();
    expect(within(row('notes/new.md')).getByText('+2')).toBeInTheDocument();
    expect(within(row('old.txt')).getByText('-5')).toBeInTheDocument();
    expect(within(row('old.txt')).getByText('Staged')).toBeInTheDocument();
    expect(within(row('src/app.ts')).queryByText('Staged')).not.toBeInTheDocument();
    expect(screen.getByText(/4 files/)).toBeInTheDocument();
    expect(screen.getByText('dispatch/side')).toBeInTheDocument();
    // The status is a word a screen reader can say, not only a colour.
    expect(within(row('notes/new.md')).getByTitle('New file')).toBeInTheDocument();
    expect(within(row('old.txt')).getByTitle('Deleted')).toBeInTheDocument();
  });

  it('opens a file to show its diff lines, and says so for a binary file', async () => {
    render(<DiffReview projectId="p1" terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show the diff of src/app.ts' }));
    expect(screen.getByText('TWO')).toBeInTheDocument();
    expect(screen.getByText('two')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show the diff of logo.png' }));
    expect(screen.getByText(/binary file/i)).toBeInTheDocument();
  });

  it('Discard asks for confirmation and names the file', async () => {
    render(<DiffReview projectId="p1" terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard src/app.ts' }));
    // Nothing is discarded yet, and the browser dialog is not used.
    expect(api.discardChanges).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('src/app.ts')).toBeInTheDocument();
    expect(within(dialog).getByText(/goes back to the last commit/i)).toBeInTheDocument();
    expect(within(dialog).queryByText('notes/new.md')).not.toBeInTheDocument();
    // Cancel discards nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.discardChanges).not.toHaveBeenCalled();
    // Confirm sends exactly that one path.
    fireEvent.click(screen.getByRole('button', { name: 'Discard src/app.ts' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard 1 file' }));
    await waitFor(() => expect(api.discardChanges).toHaveBeenCalledWith('p1', 't1', ['src/app.ts']));
    expect(api.discardChanges).toHaveBeenCalledTimes(1);
    // The answer says where the copy is.
    expect(await screen.findByText(/git cat-file -p abc1234def5678/)).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('the confirmation says that a new file is deleted', async () => {
    render(<DiffReview projectId="p1" terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard notes/new.md' }));
    expect(within(screen.getByRole('alertdialog')).getByText(/new file is deleted/i)).toBeInTheDocument();
  });

  it('Discard all names every shown file and sends exactly those paths', async () => {
    render(<DiffReview projectId="p1" terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard all' }));
    const dialog = screen.getByRole('alertdialog');
    for (const f of FILES) expect(within(dialog).getByText(f.path)).toBeInTheDocument();
    expect(api.discardChanges).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard 4 files' }));
    await waitFor(() => expect(api.discardChanges).toHaveBeenCalledWith('p1', 't1', FILES.map((f) => f.path)));
  });

  it('Approve stages the file with no confirmation and says that it makes no commit', async () => {
    render(<DiffReview projectId="p1" terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve src/app.ts' }));
    await waitFor(() => expect(api.approveChanges).toHaveBeenCalledWith('p1', 't1', ['src/app.ts']));
    expect(screen.getByText(/does not make a commit/i)).toBeInTheDocument();
    // The list is read again after the action.
    await waitFor(() => expect((api.getThreadDiff as any).mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('Approve all sends the files that are not staged yet', async () => {
    render(<DiffReview projectId="p1" terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve all' }));
    await waitFor(() => expect(api.approveChanges).toHaveBeenCalledWith('p1', 't1', ['src/app.ts', 'notes/new.md', 'logo.png']));
  });

  it('shows the shared-directory note', async () => {
    (api.getThreadDiff as any).mockResolvedValue(diff({ shared: true }));
    render(<DiffReview projectId="p1" terminalId="t1" />);
    expect(await screen.findByText(/more than one thread/i)).toBeInTheDocument();
  });

  it('has no shared-directory note when one thread uses the directory', async () => {
    render(<DiffReview projectId="p1" terminalId="t1" />);
    await screen.findByText('src/app.ts');
    expect(screen.queryByText(/more than one thread/i)).not.toBeInTheDocument();
  });

  it('shows the error of a refused discard and keeps the files', async () => {
    (api.discardChanges as any).mockRejectedValue(new Error('POST /x failed: 403 — Path traversal not allowed'));
    render(<DiffReview projectId="p1" terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard src/app.ts' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard 1 file' }));
    expect(await screen.findByText(/Path traversal not allowed/)).toBeInTheDocument();
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
  });

  it('says so when there is no change, and when the directory is not a repository', async () => {
    (api.getThreadDiff as any).mockResolvedValue(diff({ files: [] }));
    const { unmount } = render(<DiffReview projectId="p1" terminalId="t1" />);
    expect(await screen.findByText(/no uncommitted changes/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard all' })).not.toBeInTheDocument();
    unmount();
    (api.getThreadDiff as any).mockResolvedValue(diff({ files: [], repo: false, branch: null }));
    render(<DiffReview projectId="p1" terminalId="t1" />);
    expect(await screen.findByText(/not a git repository/i)).toBeInTheDocument();
  });

  it('offers a thread in a worktree as the directory to review', async () => {
    useTabs.setState({ byProject: { p1: [
      { id: 't1', sessionId: 'p1', type: 'claude-code', label: 'Main thread', workingDir: null, archivedAt: null },
      { id: 't2', sessionId: 'p1', type: 'claude-code', label: 'Side thread', workingDir: '/repo/.claude/worktrees/side', archivedAt: null },
    ] } } as any);
    render(<DiffReview projectId="p1" terminalId={null} />);
    await waitFor(() => expect(api.getThreadDiff).toHaveBeenCalledWith('p1', null));
    await screen.findByRole('combobox', { name: 'Directory to review' });
    pickOption('Directory to review', /Side thread/);
    await waitFor(() => expect(api.getThreadDiff).toHaveBeenCalledWith('p1', 't2'));
  });

  it('a worktree with no thread can be removed after a confirmation; one with uncommitted changes cannot', async () => {
    (api.listWorktrees as any).mockResolvedValue({ worktrees: [
      { path: '/repo/.claude/worktrees/old', branch: 'dispatch/old', dirty: false, inUse: false },
      { path: '/repo/.claude/worktrees/wip', branch: 'dispatch/wip', dirty: true, inUse: false },
      { path: '/repo/.claude/worktrees/live', branch: 'dispatch/live', dirty: false, inUse: true },
    ] });
    render(<DiffReview projectId="p1" terminalId="t1" />);
    expect(await screen.findByText('dispatch/old')).toBeInTheDocument();
    expect(screen.getByText('dispatch/wip')).toBeInTheDocument();
    // A worktree with a live thread is not offered.
    expect(screen.queryByText('dispatch/live')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove the worktree dispatch/wip' })).toBeDisabled();
    expect(screen.getByText(/has uncommitted changes/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove the worktree dispatch/old' }));
    expect(api.removeWorktree).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/branch dispatch\/old stays/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove worktree' }));
    await waitFor(() => expect(api.removeWorktree).toHaveBeenCalledWith('p1', '/repo/.claude/worktrees/old'));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('Back calls onClose', async () => {
    const onClose = vi.fn();
    render(<DiffReview projectId="p1" terminalId="t1" onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Back to files' }));
    expect(onClose).toHaveBeenCalled();
  });
});
