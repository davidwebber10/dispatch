import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowClockwise, CaretDown, CaretLeft, CaretRight, Check, GitBranch, Info, Trash, Warning, X } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { DiffFile, DiscardResult, ThreadDiff, ThreadWorktreeState } from '../../api/types';
import { useTabs } from '../../stores/tabs';
import { useProjects } from '../../stores/projects';
import { useGitStatus } from '../../stores/gitStatus';
import { Select } from '../common/Select';
import { useIsMobile } from '../../hooks/useIsMobile';
import { Hunk } from '../tabs/toolviews/DiffView';
import type { DiffLine } from '../tabs/toolviews/diff';

/**
 * Diff review (engineering program W3-G): the uncommitted changes of one thread's working directory.
 *
 * - Approve stages the file in git (`git add`). It makes no commit.
 * - Discard puts a tracked file back to the last commit and deletes a new file. It always asks first, in the page
 *   (never `window.confirm`), and the question names each file. Only the named files are sent to the daemon.
 * - A thread that runs in its own worktree is reviewed in that worktree; the picker switches directory.
 */

const STATUS: Record<DiffFile['status'], { letter: string; word: string; color: string }> = {
  modified: { letter: 'M', word: 'Modified', color: 'var(--color-status-yellow)' },
  added: { letter: 'A', word: 'New file', color: 'var(--color-status-green)' },
  untracked: { letter: 'N', word: 'New file', color: 'var(--color-status-green)' },
  deleted: { letter: 'D', word: 'Deleted', color: 'var(--color-status-red)' },
  renamed: { letter: 'R', word: 'Renamed', color: 'var(--color-accent)' },
};

/** What Discard does to one file, in words. The confirmation shows this next to the path. */
export function discardEffect(f: DiffFile): string {
  if (f.status === 'untracked' || f.status === 'added') return 'The new file is deleted.';
  if (f.status === 'deleted') return 'The deleted file comes back.';
  if (f.status === 'renamed') return `The file goes back to ${f.oldPath ?? 'its old name'}, with the content of the last commit.`;
  return 'The file goes back to the last commit.';
}

/** Split a unified patch into hunks of diff lines. The `\ No newline` marker is not a line of the file. */
export function parsePatch(patch: string): { header: string; lines: DiffLine[] }[] {
  const hunks: { header: string; lines: DiffLine[] }[] = [];
  const rows = patch.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  for (const row of rows) {
    if (row.startsWith('@@')) { hunks.push({ header: row, lines: [] }); continue; }
    if (row.startsWith('\\')) continue;
    const cur = hunks[hunks.length - 1] ?? (hunks.push({ header: '', lines: [] }), hunks[hunks.length - 1]);
    cur.lines.push({ type: row[0] === '+' ? 'add' : row[0] === '-' ? 'del' : 'ctx', text: row.slice(1) });
  }
  return hunks;
}

/** The server's reason from an ApiError ("POST /x failed: 403 — reason"), or the whole message. */
function reason(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const at = m.indexOf(' — ');
  return at >= 0 ? m.slice(at + 3) : m;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p;

const ICON_BTN_BASE: React.CSSProperties = {
  width: 28, height: 28, flexShrink: 0, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
  color: 'var(--color-text-secondary)',
};
const TEXT_BTN_BASE: React.CSSProperties = {
  height: 28, padding: '0 10px', display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0,
  background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
  font: '500 12px var(--font-sans)', color: 'var(--color-text-primary)', cursor: 'pointer', whiteSpace: 'nowrap',
};
const NOTE: React.CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px', margin: '8px 10px 0',
  border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-elevated)',
  font: '400 12px/1.45 var(--font-sans)', color: 'var(--color-text-secondary)',
};

type Confirm = { kind: 'discard'; files: DiffFile[] } | { kind: 'worktree'; worktree: ThreadWorktreeState };

export function DiffReview({ projectId, terminalId, onClose }: { projectId: string | null; terminalId: string | null; onClose?: () => void }) {
  // A phone gets finger-sized controls (36px); the desktop column keeps 28px.
  const phone = useIsMobile();
  const ICON_BTN: React.CSSProperties = phone ? { ...ICON_BTN_BASE, width: 36, height: 36 } : ICON_BTN_BASE;
  const TEXT_BTN: React.CSSProperties = phone ? { ...TEXT_BTN_BASE, height: 38, fontSize: 14, padding: '0 14px' } : TEXT_BTN_BASE;
  const DANGER_BTN: React.CSSProperties = { ...TEXT_BTN, background: 'var(--color-status-red)', borderColor: 'var(--color-status-red)', color: 'var(--color-on-accent)', fontWeight: 600 };
  const project = useProjects((s) => s.sessions.find((x) => x.id === projectId));
  const tabs = useTabs((s) => (projectId ? s.byProject[projectId] : undefined));
  // Threads that run in their own directory (a worktree). The others share the project directory.
  const ownDir = useMemo(
    () => (tabs ?? []).filter((t) => !!t.workingDir && t.workingDir !== project?.workingDir && !t.archivedAt && t.type !== 'file' && t.type !== 'browser' && t.type !== 'notes'),
    [tabs, project?.workingDir],
  );
  const [target, setTarget] = useState<string | null>(terminalId);
  useEffect(() => { setTarget(terminalId); }, [terminalId, projectId]);

  const [diff, setDiff] = useState<ThreadDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<DiscardResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<ThreadWorktreeState[]>([]);
  // Only the answer to the newest request is shown (a slow answer for the directory before must not replace it).
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!projectId) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const d = await api.getThreadDiff(projectId, target);
      if (mine !== seq.current) return;
      setDiff(d); setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(reason(e));
    } finally { if (mine === seq.current) setLoading(false); }
    void api.listWorktrees(projectId).then((r) => { if (mine === seq.current) setWorktrees(r.worktrees); }).catch(() => {});
  }, [projectId, target]);

  useEffect(() => { setDiff(null); setOpen(new Set()); setConfirm(null); setDone(null); setMessage(null); void load(); }, [load]);

  const afterChange = useCallback(async () => {
    await load();
    if (projectId) void useGitStatus.getState().refresh(projectId);
  }, [load, projectId]);

  // Files the daemon acts on. A folder with its own repository and a credentials path are shown, not acted on.
  const actionable = useMemo(() => (diff?.files ?? []).filter((f) => !f.patchOmitted || f.patchOmitted === 'large'), [diff]);
  const totals = useMemo(() => (diff?.files ?? []).reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 }), [diff]);

  async function approve(files: DiffFile[]) {
    if (!projectId || busy || files.length === 0) return;
    setBusy(true); setError(null); setDone(null);
    try {
      await api.approveChanges(projectId, target, files.map((f) => f.path));
      setMessage(`${plural(files.length, 'file')} staged. Dispatch did not make a commit.`);
      await afterChange();
    } catch (e) { setError(reason(e)); } finally { setBusy(false); }
  }

  async function discard(files: DiffFile[]) {
    if (!projectId || busy || files.length === 0) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const res = await api.discardChanges(projectId, target, files.map((f) => f.path));
      setConfirm(null);
      await afterChange();
      setDone(res);
      if (res.errors.length) setError(res.errors.map((x) => `${x.path}: ${x.error}`).join(' '));
    } catch (e) { setError(reason(e)); setConfirm(null); } finally { setBusy(false); }
  }

  async function removeWorktree(w: ThreadWorktreeState) {
    if (!projectId || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await api.removeWorktree(projectId, w.path);
      setMessage(`The worktree ${baseName(res.path)} is removed. The branch ${res.branch} stays.`);
      setConfirm(null);
      await afterChange();
    } catch (e) { setError(reason(e)); setConfirm(null); } finally { setBusy(false); }
  }

  // The question shows at the top of the list. From a row far down, bring it into view and put the focus on Cancel.
  const confirmRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!confirm) return;
    confirmRef.current?.scrollIntoView?.({ block: 'nearest' });
    confirmRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [confirm]);

  const toggle = (p: string) => setOpen((prev) => { const n = new Set(prev); if (n.has(p)) n.delete(p); else n.add(p); return n; });

  async function loadOne(path: string) {
    if (!projectId) return;
    try {
      const d = await api.getThreadDiff(projectId, target, path);
      const one = d.files[0];
      if (one) setDiff((prev) => (prev ? { ...prev, files: prev.files.map((f) => (f.path === path ? one : f)) } : prev));
    } catch (e) { setError(reason(e)); }
  }

  const options = [
    { value: '', label: 'Project directory' },
    ...ownDir.map((t) => ({ value: t.id, label: `${t.label} (${baseName(t.workingDir ?? '')})` })),
  ];
  const targetValue = target && ownDir.some((t) => t.id === target) ? target : '';
  const idle = worktrees.filter((w) => !w.inUse);
  const files = diff?.files ?? [];
  const toApprove = actionable.filter((f) => !f.staged);

  return (
    <div data-testid="diff-review" style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
      <div style={{ padding: '7px 10px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {onClose && (
          <button type="button" aria-label="Back to files" title="Back to files" onClick={onClose} style={{ ...ICON_BTN, border: 'none' }}>
            <CaretLeft size={16} weight="bold" />
          </button>
        )}
        <span style={{ flex: 1, minWidth: 0, font: '600 13px var(--font-sans)', color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Review changes</span>
        {diff?.branch && (
          <span title="Branch of this directory" style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 1, minWidth: 0,
            font: '500 10.5px var(--font-mono)', color: 'var(--color-accent)',
            background: 'color-mix(in srgb, var(--color-accent) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--color-accent) 25%, transparent)',
            borderRadius: 'var(--radius-sm)', padding: '1px 6px', maxWidth: 170,
          }}>
            <GitBranch size={11} weight="bold" style={{ flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{diff.branch}</span>
          </span>
        )}
        <button type="button" aria-label="Refresh" title="Refresh" onClick={() => void load()} style={ICON_BTN}>
          <ArrowClockwise size={14} />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', paddingBottom: 12 }}>
        {ownDir.length > 0 && (
          <div style={{ padding: '8px 10px 0' }}>
            <Select ariaLabel="Directory to review" value={targetValue} options={options} onChange={(v) => setTarget(v || null)} style={{ width: '100%' }} />
          </div>
        )}
        {diff && (
          <div title={diff.workDir} style={{ padding: '6px 10px 0', font: '400 11px var(--font-mono)', color: 'var(--color-text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>
            <bdi>{diff.workDir}</bdi>
          </div>
        )}

        {diff?.shared && (
          <div role="note" style={NOTE}>
            <Info size={15} style={{ flexShrink: 0, marginTop: 1, color: 'var(--color-status-amber)' }} />
            <span>Other threads use this directory. These changes can come from more than one thread.</span>
          </div>
        )}
        {error && (
          <div role="alert" style={{ ...NOTE, borderColor: 'var(--color-status-red)', color: 'var(--color-text-primary)' }}>
            <Warning size={15} style={{ flexShrink: 0, marginTop: 1, color: 'var(--color-status-red)' }} />
            <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{error}</span>
            <button type="button" aria-label="Dismiss the error" onClick={() => setError(null)} style={{ ...ICON_BTN, width: 20, height: 20, border: 'none' }}><X size={12} /></button>
          </div>
        )}
        {message && !error && (
          <div role="status" style={NOTE}>
            <Check size={15} style={{ flexShrink: 0, marginTop: 1, color: 'var(--color-status-green)' }} />
            <span style={{ flex: 1, minWidth: 0 }}>{message}</span>
            <button type="button" aria-label="Dismiss the message" onClick={() => setMessage(null)} style={{ ...ICON_BTN, width: 20, height: 20, border: 'none' }}><X size={12} /></button>
          </div>
        )}
        {done && done.discarded.length > 0 && (
          <div role="status" style={{ ...NOTE, flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', width: '100%' }}>
              <Check size={15} style={{ flexShrink: 0, marginTop: 1, color: 'var(--color-status-green)' }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                {plural(done.discarded.length, 'file')} discarded.
                {done.discarded.some((d) => d.backup) && ' Git holds a copy of the content from before. This command prints it:'}
              </span>
              <button type="button" aria-label="Dismiss the message" onClick={() => setDone(null)} style={{ ...ICON_BTN, width: 20, height: 20, border: 'none' }}><X size={12} /></button>
            </div>
            {done.discarded.filter((d) => d.backup).map((d) => (
              <code key={d.path} style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-primary)', overflowWrap: 'anywhere', paddingLeft: 23 }}>
                git cat-file -p {d.backup} &gt; {d.path}
              </code>
            ))}
          </div>
        )}

        {confirm && (
          <div ref={confirmRef} role="alertdialog" aria-label={confirm.kind === 'discard' ? 'Confirm the discard' : 'Confirm the removal of the worktree'}
            style={{ margin: '8px 10px 0', padding: 10, border: '1px solid var(--color-status-red)', borderRadius: 'var(--radius-md)', background: 'color-mix(in srgb, var(--color-status-red) 8%, var(--color-elevated))', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {confirm.kind === 'discard' ? (
              <>
                <div style={{ font: '600 13px var(--font-sans)', color: 'var(--color-text-primary)' }}>
                  Discard the changes in {plural(confirm.files.length, 'file')}?
                </div>
                <div style={{ font: '400 12px/1.45 var(--font-sans)', color: 'var(--color-text-secondary)' }}>
                  Dispatch changes only the files in this list. Other files keep their changes.
                </div>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 220, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {confirm.files.map((f) => (
                    <li key={f.path} style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                      <span style={{ font: '500 12px var(--font-mono)', color: 'var(--color-text-primary)', overflowWrap: 'anywhere' }}>{f.path}</span>
                      <span style={{ font: '400 11.5px var(--font-sans)', color: 'var(--color-text-secondary)' }}>{discardEffect(f)}</span>
                    </li>
                  ))}
                </ul>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => setConfirm(null)} disabled={busy} style={TEXT_BTN}>Cancel</button>
                  <button type="button" onClick={() => void discard(confirm.files)} disabled={busy} style={{ ...DANGER_BTN, opacity: busy ? 0.7 : 1 }}>
                    <Trash size={14} />Discard {plural(confirm.files.length, 'file')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ font: '600 13px var(--font-sans)', color: 'var(--color-text-primary)' }}>Remove this worktree?</div>
                <div style={{ font: '500 12px var(--font-mono)', color: 'var(--color-text-primary)', overflowWrap: 'anywhere' }}>{confirm.worktree.path}</div>
                <div style={{ font: '400 12px/1.45 var(--font-sans)', color: 'var(--color-text-secondary)' }}>
                  It has no uncommitted changes. The folder is removed. The branch {confirm.worktree.branch} stays, with its commits.
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => setConfirm(null)} disabled={busy} style={TEXT_BTN}>Cancel</button>
                  <button type="button" onClick={() => void removeWorktree(confirm.worktree)} disabled={busy} style={{ ...DANGER_BTN, opacity: busy ? 0.7 : 1 }}>
                    <Trash size={14} />Remove worktree
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {diff && !diff.repo && (
          <div style={{ padding: '16px 12px', font: '400 13px/1.5 var(--font-sans)', color: 'var(--color-text-tertiary)' }}>This directory is not a git repository. There is nothing to review.</div>
        )}
        {diff && diff.repo && files.length === 0 && (
          <div style={{ padding: '16px 12px', font: '400 13px/1.5 var(--font-sans)', color: 'var(--color-text-tertiary)' }}>No uncommitted changes.</div>
        )}
        {!diff && loading && (
          <div style={{ padding: '16px 12px', font: '400 13px var(--font-sans)', color: 'var(--color-text-tertiary)' }}>Loading…</div>
        )}

        {files.length > 0 && (
          <>
            <div style={{ padding: '10px 10px 0', font: '500 12px var(--font-sans)', color: 'var(--color-text-secondary)' }}>
              {plural(files.length, 'file')}
              <span style={{ color: 'var(--color-status-green)', marginLeft: 8, fontFamily: 'var(--font-mono)' }}>+{totals.add}</span>
              <span style={{ color: 'var(--color-status-red)', marginLeft: 6, fontFamily: 'var(--font-mono)' }}>-{totals.del}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px 6px' }}>
              <button type="button" onClick={() => void approve(toApprove)} disabled={busy || toApprove.length === 0} style={{ ...TEXT_BTN, flex: 1, justifyContent: 'center', opacity: busy || toApprove.length === 0 ? 0.5 : 1 }}>
                <Check size={14} />Approve all
              </button>
              <button type="button" onClick={() => setConfirm({ kind: 'discard', files: actionable })} disabled={busy || actionable.length === 0} style={{ ...TEXT_BTN, flex: 1, justifyContent: 'center', color: 'var(--color-status-red)', opacity: busy || actionable.length === 0 ? 0.5 : 1 }}>
                <Trash size={14} />Discard all
              </button>
            </div>
            <div style={{ padding: '0 10px 6px', font: '400 11.5px/1.4 var(--font-sans)', color: 'var(--color-text-tertiary)' }}>
              Approve stages a file in git. It does not make a commit.
            </div>
            {diff?.truncated && (
              <div role="note" style={{ ...NOTE, marginTop: 0, marginBottom: 6 }}>
                <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>The changes are large. Some diff text is not loaded. Open a file to load its diff.</span>
              </div>
            )}
            <div>
              {files.map((f) => {
                const st = STATUS[f.status];
                const isOpen = open.has(f.path);
                const canAct = actionable.includes(f);
                return (
                  <div key={f.path} data-testid={`diff-file-${f.path}`} style={{ borderTop: '1px solid var(--color-border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px 5px 4px', minWidth: 0 }}>
                      <button type="button" aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} the diff of ${f.path}`} onClick={() => toggle(f.path)}
                        style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: '4px 0 4px 4px', cursor: 'pointer', textAlign: 'left', color: 'var(--color-text-primary)' }}>
                        {isOpen ? <CaretDown size={12} style={{ flexShrink: 0 }} /> : <CaretRight size={12} style={{ flexShrink: 0 }} />}
                        <span title={st.word} aria-label={st.word} style={{ flexShrink: 0, width: 16, textAlign: 'center', font: '700 11px var(--font-mono)', color: st.color }}>{st.letter}</span>
                        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                          <span style={{ font: '400 12px var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}><bdi>{f.path}</bdi></span>
                          {f.oldPath && <span style={{ font: '400 10.5px var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>from {f.oldPath}</span>}
                        </span>
                      </button>
                      {f.staged && <span title="Staged in git. Not committed." style={{ flexShrink: 0, font: '600 10px var(--font-sans)', color: 'var(--color-status-green)', border: '1px solid color-mix(in srgb, var(--color-status-green) 45%, transparent)', borderRadius: 'var(--radius-sm)', padding: '0 5px', lineHeight: '16px' }}>Staged</span>}
                      <span style={{ flexShrink: 0, font: '500 11px var(--font-mono)', display: 'inline-flex', gap: 5 }}>
                        {f.binary ? <span style={{ color: 'var(--color-text-tertiary)' }}>binary</span> : (
                          <>
                            {f.additions > 0 && <span style={{ color: 'var(--color-status-green)' }}>+{f.additions}</span>}
                            {f.deletions > 0 && <span style={{ color: 'var(--color-status-red)' }}>-{f.deletions}</span>}
                          </>
                        )}
                      </span>
                      <button type="button" aria-label={`Approve ${f.path}`} title={f.staged ? 'Staged' : 'Approve: stage this file. No commit.'} disabled={busy || !canAct || f.staged}
                        onClick={() => void approve([f])} style={{ ...ICON_BTN, color: 'var(--color-status-green)', opacity: busy || !canAct || f.staged ? 0.35 : 1 }}>
                        <Check size={14} weight="bold" />
                      </button>
                      <button type="button" aria-label={`Discard ${f.path}`} title="Discard the changes of this file" disabled={busy || !canAct}
                        onClick={() => setConfirm({ kind: 'discard', files: [f] })} style={{ ...ICON_BTN, color: 'var(--color-status-red)', opacity: busy || !canAct ? 0.35 : 1 }}>
                        <Trash size={14} />
                      </button>
                    </div>
                    {isOpen && (
                      <div style={{ borderTop: '1px solid var(--color-border)', background: 'var(--color-base)' }}>
                        {f.binary ? <div style={EMPTY_PATCH}>Binary file. There is no text diff.</div>
                          : f.patchOmitted === 'secret' ? <div style={EMPTY_PATCH}>This path holds credentials. Dispatch does not show it.</div>
                          : f.patchOmitted === 'directory' ? <div style={EMPTY_PATCH}>A folder with its own git repository. Review it in that repository.</div>
                          : f.patch === undefined || f.patchOmitted === 'large' ? (
                            <div style={{ ...EMPTY_PATCH, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <span>The diff of this file is not loaded.</span>
                              <button type="button" onClick={() => void loadOne(f.path)} style={TEXT_BTN}>Load the diff</button>
                            </div>
                          ) : f.patch === '' ? <div style={EMPTY_PATCH}>{f.status === 'renamed' ? 'Renamed. The content is the same.' : 'No text change (an empty file, or a change of file mode).'}</div>
                          : (
                            <>
                              {parsePatch(f.patch).map((h, i) => (
                                <div key={i} style={{ borderTop: i > 0 ? '1px solid var(--color-border)' : 'none' }}>
                                  {h.header && <div style={{ padding: '2px 11px', font: '400 10.5px var(--font-mono)', color: 'var(--color-text-tertiary)', background: 'var(--color-elevated)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.header}</div>}
                                  <Hunk lines={h.lines} />
                                </div>
                              ))}
                              {f.patchCut && (
                                <div style={{ ...EMPTY_PATCH, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                  <span>The diff is cut here.</span>
                                  <button type="button" onClick={() => void loadOne(f.path)} style={TEXT_BTN}>Load more</button>
                                </div>
                              )}
                            </>
                          )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {idle.length > 0 && (
          <div style={{ marginTop: 14, borderTop: '1px solid var(--color-border)' }}>
            <div style={{ padding: '10px 10px 2px', font: '600 12px var(--font-sans)', color: 'var(--color-text-secondary)' }}>Worktrees with no thread</div>
            <div style={{ padding: '0 10px 6px', font: '400 11.5px/1.4 var(--font-sans)', color: 'var(--color-text-tertiary)' }}>
              Dispatch made these for threads that are archived now. You can remove one when it has no uncommitted changes.
            </div>
            {idle.map((w) => (
              <div key={w.path} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderTop: '1px solid var(--color-border)', minWidth: 0 }}>
                <GitBranch size={13} style={{ flexShrink: 0, color: 'var(--color-text-tertiary)' }} />
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <span style={{ font: '400 12px var(--font-mono)', color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.branch}</span>
                  <span style={{ font: '400 11px var(--font-sans)', color: w.dirty ? 'var(--color-status-amber)' : 'var(--color-text-tertiary)' }}>
                    {w.dirty ? 'Has uncommitted changes. Dispatch does not remove it.' : 'No uncommitted changes.'}
                  </span>
                </span>
                <button type="button" aria-label={`Remove the worktree ${w.branch}`} title={w.dirty ? 'Has uncommitted changes' : 'Remove this worktree. The branch stays.'} disabled={busy || w.dirty}
                  onClick={() => setConfirm({ kind: 'worktree', worktree: w })} style={{ ...ICON_BTN, opacity: busy || w.dirty ? 0.35 : 1 }}>
                  <Trash size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const EMPTY_PATCH: React.CSSProperties = { padding: '8px 11px', font: '400 12px/1.45 var(--font-sans)', color: 'var(--color-text-tertiary)' };
