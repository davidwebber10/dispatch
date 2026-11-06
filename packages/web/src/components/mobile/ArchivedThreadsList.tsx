import { useEffect, useState } from 'react';
import { ArrowCounterClockwise, Archive } from '@phosphor-icons/react';
import type { Terminal } from '../../api/types';
import { api } from '../../api/client';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { Spinner } from '../common/Spinner';

const when = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

/**
 * The Threads view's Archived tab (2026-11-05): every project's archived threads, newest
 * archived first, with the project, when it was archived, and Restore (which respawns the
 * thread and opens it, as a project's Archived section does). `project` narrows to one project;
 * `query` matches the label or the project name.
 */
export function ArchivedThreadsList({ project, query, onOpenThread }: { project: string | null; query: string; onOpenThread: (projectId: string, tabId: string) => void }) {
  const projects = useProjects((s) => s.sessions);
  const [rows, setRows] = useState<Terminal[] | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all(projects.map((p) => api.listArchivedTerminals(p.id).catch(() => [] as Terminal[])))
      .then((lists) => { if (alive) setRows(lists.flat().filter((t) => t.type !== 'file')); });
    return () => { alive = false; };
    // Once per mount: restoring removes rows here directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nameOf = new Map(projects.map((p) => [p.id, p.name]));
  const q = query.trim().toLowerCase();
  const shown = (rows ?? [])
    .filter((t) => !project || t.sessionId === project)
    .filter((t) => !q || t.label.toLowerCase().includes(q) || (nameOf.get(t.sessionId) ?? '').toLowerCase().includes(q))
    .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''));

  async function restore(t: Terminal) {
    if (restoring) return;
    setRestoring(t.id); setFailed(null);
    try {
      const restored = await api.restoreTerminal(t.id);
      setRows((cur) => (cur ?? []).filter((r) => r.id !== t.id));
      await useTabs.getState().loadTabs(t.sessionId);
      onOpenThread(t.sessionId, restored.id);
    } catch { setFailed(t.id); }
    finally { setRestoring(null); }
  }

  if (rows === null) return <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={24} /></div>;
  if (!shown.length) {
    return (
      <div style={{ padding: '48px 28px', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13.5 }}>
        <Archive size={30} style={{ opacity: 0.5 }} />
        <div style={{ marginTop: 10 }}>{q || project ? 'No archived threads match.' : 'No archived threads.'}</div>
      </div>
    );
  }
  return (
    <div data-testid="archived-threads">
      {shown.map((t) => (
        <div key={t.id} data-archived-id={t.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 12px', borderBottom: '1px solid var(--color-border)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.label}</div>
            <div style={{ font: '400 11.5px var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {[project ? null : nameOf.get(t.sessionId), t.archivedAt ? `archived ${when(t.archivedAt)}` : null].filter(Boolean).join(' · ')}
            </div>
            {failed === t.id && <div role="alert" style={{ fontSize: 12, color: 'var(--color-status-red)', marginTop: 2 }}>Could not restore. Try again.</div>}
          </div>
          <button type="button" aria-label={`Restore ${t.label}`} disabled={restoring === t.id} onClick={() => void restore(t)}
            style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 11px', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', fontSize: 13, cursor: 'pointer', opacity: restoring === t.id ? 0.6 : 1 }}>
            {restoring === t.id ? <Spinner size={13} /> : <ArrowCounterClockwise size={14} weight="bold" />}
            Restore
          </button>
        </div>
      ))}
    </div>
  );
}
