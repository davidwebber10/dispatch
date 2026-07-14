import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// Captures the seams CodeMirror's mount effect passes through, so tests can assert on them
// without touching real CodeMirror DOM: the `doc` text a fresh editor is constructed with, and
// the `updateListener` callback FileEditorTab registers to mirror doc changes back into `content`.
const codeMirrorState = vi.hoisted(() => ({
  capturedDoc: undefined as string | undefined,
  updateListener: undefined as ((u: { docChanged: boolean; state: { doc: { toString: () => string } } }) => void) | undefined,
}));

vi.mock('codemirror', () => ({
  EditorView: class {
    state = { doc: { toString: () => '' } };
    destroy() {}
    static updateListener = { of: (cb: typeof codeMirrorState.updateListener) => { codeMirrorState.updateListener = cb; return {}; } };
  },
  basicSetup: [],
}));
vi.mock('@codemirror/state', () => ({
  EditorState: { create: (cfg: { doc: string }) => { codeMirrorState.capturedDoc = cfg.doc; return {}; } },
}));
vi.mock('@codemirror/theme-one-dark', () => ({ oneDark: {} }));

import { FileEditorTab } from './FileEditorTab';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';
import { useTabs } from '../../stores/tabs';
import { clearDraft, hasDraft } from '../../lib/fileDrafts';

function tab(path: string): Terminal {
  return { id: 't1', sessionId: 's1', type: 'file', label: path, config: { path } } as unknown as Terminal;
}

describe('FileEditorTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'writeFile').mockResolvedValue({ ok: true, path: 'x' } as never);
    codeMirrorState.capturedDoc = undefined;
    codeMirrorState.updateListener = undefined;
    // The draft map and the tabs store are module-level (drafts must outlive the component —
    // that is the point), so reset both or one test's unsaved edit leaks into the next.
    clearDraft('t1');
    useTabs.setState({ dirtyTabs: {} });
  });

  it('loads the file content and shows the path + save control', async () => {
    vi.spyOn(api, 'readFile').mockResolvedValue({ content: 'hello', path: 'src/a.ts' });
    render(<FileEditorTab terminal={tab('src/a.ts')} />);

    await waitFor(() => expect(api.readFile).toHaveBeenCalledWith('s1', 'src/a.ts'));
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
  });

  it('shows a Table|Raw toggle and the grid for a .csv', async () => {
    vi.spyOn(api, 'readFile').mockResolvedValue({ content: 'name,qty\napples,3\n', path: 'd.csv' });
    render(<FileEditorTab terminal={tab('d.csv')} />);

    expect(await screen.findByText('table')).toBeInTheDocument();
    expect(screen.getByText('raw')).toBeInTheDocument();
    expect(await screen.findByText('apples')).toBeInTheDocument();  // the grid, not raw text
  });

  it('keeps View|Edit for markdown and offers no toggle for code', async () => {
    vi.spyOn(api, 'readFile').mockResolvedValue({ content: '# hi', path: 'a.md' });
    const { unmount } = render(<FileEditorTab terminal={tab('a.md')} />);
    expect(await screen.findByText('view')).toBeInTheDocument();
    expect(screen.queryByText('table')).toBeNull();
    unmount();

    vi.spyOn(api, 'readFile').mockResolvedValue({ content: 'const x = 1', path: 'a.ts' });
    render(<FileEditorTab terminal={tab('a.ts')} />);
    await waitFor(() => expect(screen.queryByText('view')).toBeNull());
    expect(screen.queryByText('table')).toBeNull();
  });

  it('a grid edit marks the file dirty and saves the serialized CSV', async () => {
    vi.spyOn(api, 'readFile').mockResolvedValue({ content: 'name,qty\napples,3\n', path: 'd.csv' });
    render(<FileEditorTab terminal={tab('d.csv')} />);

    fireEvent.doubleClick(await screen.findByText('apples'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'bananas' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText('● unsaved')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(api.writeFile).toHaveBeenCalledWith('s1', 'd.csv', 'name,qty\nbananas,3\n'),
    );
  });

  // Pins the Table<->Raw coherence guarantee: `content` is the single source of truth and
  // CsvGrid/CodeMirror are both projections of it, so an edit made in one view MUST be visible
  // when switching to the other — never stale, never lost.

  it('carries a Table edit into Raw mode (Table→Raw coherence)', async () => {
    vi.spyOn(api, 'readFile').mockResolvedValue({ content: 'name,qty\napples,3\n', path: 'd.csv' });
    render(<FileEditorTab terminal={tab('d.csv')} />);

    fireEvent.doubleClick(await screen.findByText('apples'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'bananas' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('● unsaved')).toBeInTheDocument();

    // The edit lives only in React state (`content`) until we switch views — this is exactly
    // the moment a stale-remount bug would hand CodeMirror the ORIGINAL text instead.
    fireEvent.click(screen.getByText('raw'));

    await waitFor(() => expect(codeMirrorState.capturedDoc).toBe('name,qty\nbananas,3\n'));
  });

  it('carries a Raw edit into Table mode (Raw→Table coherence)', async () => {
    vi.spyOn(api, 'readFile').mockResolvedValue({ content: 'name,qty\napples,3\n', path: 'd.csv' });
    render(<FileEditorTab terminal={tab('d.csv')} />);

    await screen.findByText('apples'); // starts in Table mode

    fireEvent.click(screen.getByText('raw'));
    await waitFor(() => expect(codeMirrorState.updateListener).toBeTruthy());

    // Drive the real updateListener FileEditorTab registered with CodeMirror — this is the
    // exact mechanism that mirrors a Raw-mode doc change into `content` in the running app.
    act(() => {
      codeMirrorState.updateListener!({ docChanged: true, state: { doc: { toString: () => 'name,qty\ncherries,9\n' } } });
    });

    fireEvent.click(screen.getByText('table'));

    expect(await screen.findByText('cherries')).toBeInTheDocument();
  });

  /* ── Unsaved edits must survive a tab switch ───────────────────────────────
     TabHost UNMOUNTS an inactive tab. So "switch to another tab and come back" is, to this
     component, a full unmount + remount — and before fileDrafts existed, that silently
     destroyed the user's unsaved work twice over: the edit died with the component's state,
     and the remount's fetch effect then refetched the server's copy over the top. */

  async function editCsvCell(from: string, to: string) {
    fireEvent.doubleClick(await screen.findByText(from));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: to } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('● unsaved')).toBeInTheDocument();
  }

  it('keeps an unsaved edit when the tab is backgrounded and reopened (no refetch over the draft)', async () => {
    vi.spyOn(api, 'readFile').mockResolvedValue({ content: 'name,qty\napples,3\n', path: 'd.csv' });
    const { unmount } = render(<FileEditorTab terminal={tab('d.csv')} />);

    await editCsvCell('apples', 'kiwis');
    expect(api.readFile).toHaveBeenCalledTimes(1);

    unmount();                                       // ← user clicks another tab: TabHost unmounts this one
    render(<FileEditorTab terminal={tab('d.csv')} />); // ← and clicks back

    // The edit is still there, still flagged unsaved...
    expect(await screen.findByText('kiwis')).toBeInTheDocument();
    expect(screen.getByText('● unsaved')).toBeInTheDocument();
    expect(screen.queryByText('apples')).toBeNull();  // the stale on-disk value did NOT come back

    // ...and the server was never asked again — a refetch here would clobber the draft.
    await waitFor(() => expect(api.readFile).toHaveBeenCalledTimes(1));
  });

  it('leaves the tab marked dirty in the store after unmount (a backgrounded tab is still unsaved)', async () => {
    vi.spyOn(api, 'readFile').mockResolvedValue({ content: 'name,qty\napples,3\n', path: 'd.csv' });
    const { unmount } = render(<FileEditorTab terminal={tab('d.csv')} />);

    await editCsvCell('apples', 'kiwis');
    expect(useTabs.getState().dirtyTabs.t1).toBe(true);

    unmount();

    // The tab is merely in the BACKGROUND — it is still open, and still unsaved. If unmounting
    // cleared this flag, clicking × on the background tab would close it with no prompt.
    expect(useTabs.getState().dirtyTabs.t1).toBe(true);
  });

  it('drops the draft once saved, so a reopened tab is clean and reloads from disk', async () => {
    vi.spyOn(api, 'readFile').mockResolvedValue({ content: 'name,qty\napples,3\n', path: 'd.csv' });
    const { unmount } = render(<FileEditorTab terminal={tab('d.csv')} />);

    await editCsvCell('apples', 'kiwis');
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(api.writeFile).toHaveBeenCalledWith('s1', 'd.csv', 'name,qty\nkiwis,3\n'));
    await waitFor(() => expect(screen.queryByText('● unsaved')).toBeNull());
    expect(hasDraft('t1')).toBe(false);
    expect(useTabs.getState().dirtyTabs.t1).toBeUndefined();

    unmount();
    render(<FileEditorTab terminal={tab('d.csv')} />);

    // Nothing to protect now, so the file is fetched fresh again and the tab comes back clean.
    await waitFor(() => expect(api.readFile).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('apples')).toBeInTheDocument();
    expect(screen.queryByText('● unsaved')).toBeNull();
  });
});
