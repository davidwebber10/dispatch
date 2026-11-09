import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Archive, ArrowClockwise, ChartBar, ChatCircleDots, Folder, Gear, Network, Plus, PuzzlePiece, Stop } from '@phosphor-icons/react';
import { useUI, type View } from '../stores/ui';
import { useContributions } from '../plugins/registry';
import { SETTINGS_SECTIONS } from './settings/sections';
import { primaryMod } from '../lib/hostkeys';
import { fuzzyScore } from '../lib/fuzzy';
import { api } from '../api/client';
import type { Terminal } from '../api/types';
import { useProjects } from '../stores/projects';
import { useTabs, findTerminal, isDispatchTab } from '../stores/tabs';
import { useDispatchName } from '../stores/settings';
import { usePickerRequest } from '../stores/pickerRequest';
import { useAgentUI } from '../stores/agentUI';
import { useHint } from '../stores/hint';
import { StatusDot } from './common/StatusDot';
import { ConfirmModal } from './common/ConfirmModal';
import { THREADS_ICON } from './common/viewIcons';
import { NewThreadModal } from './sidebar/NewThreadModal';

/**
 * The command palette: ⌘K / Ctrl+K on the desktop.
 *
 * Rows (engineering program 2026-11-09, W1-G): the threads of every project with a status dot,
 * each project, the coordinator of each project, "New thread in <project>", the actions for the
 * active thread (stop, restart, archive), then the views, the settings sections and the plugin
 * commands (docs/superpowers/specs/2026-11-07-plugins-design.md, section 2; plugins slice 6).
 *
 * With an empty query the threads come first: needs input, error, working, then the most recent
 * activity. Typing ranks every row with `fuzzyScore`. Up and Down move, Enter runs, Escape closes.
 *
 * The palette never creates a thread. "New thread" asks for the thread picker through
 * stores/pickerRequest.ts (owner `new-thread:<projectId>`); the person creates the thread there.
 */
interface Row {
  key: string;
  label: string;
  hint: string;
  /** More text to match the query against (a thread's project name). The label ranks higher. */
  match?: string;
  icon: ReactNode;
  run: () => void;
}

/** The owner prefix of a thread picker request (stores/pickerRequest.ts). */
const NEW_THREAD_OWNER = 'new-thread:';
/** The thread rows shown before a query is typed. Typing searches all of them. */
const EMPTY_QUERY_THREADS = 12;
const MAX_ROWS = 60;
/** A tab that is not a thread: a file, a browser, notes. */
const NOT_A_THREAD = new Set(['file', 'browser', 'notes']);

const isThread = (t: Terminal): boolean => !t.archivedAt && !NOT_A_THREAD.has(t.type) && t.config?.role !== 'coordinator';
const dotState = (status: string): 'working' | 'idle' | 'needs_input' | 'error' =>
  status === 'working' || status === 'needs_input' || status === 'error' ? status : 'idle';
const STATUS_RANK: Record<string, number> = { needs_input: 0, error: 1, working: 2 };
const activityTime = (t: Terminal): number => Date.parse(t.lastActivityAt ?? t.createdAt) || 0;
/** Needs input, error, working, then the most recent activity. */
export function byAttention(a: Terminal, b: Terminal): number {
  return (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3) || activityTime(b) - activityTime(a);
}

const ICON = 15;
const VIEW_ROWS: { view: View; label: string; icon: ReactNode }[] = [
  { view: 'workspace', label: 'Threads', icon: <THREADS_ICON size={ICON} /> },
  { view: 'chat', label: 'Chat', icon: <ChatCircleDots size={ICON} /> },
  { view: 'analytics', label: 'Analytics', icon: <ChartBar size={ICON} /> },
  { view: 'settings', label: 'Settings', icon: <Gear size={ICON} /> },
];

/** Show the Threads view, where a thread, a project or the coordinator opens. */
function showThreads(): void {
  useAgentUI.getState().blur();
  useUI.getState().setView('workspace');
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const [confirm, setConfirm] = useState<{ kind: 'archive' | 'restart'; thread: Terminal } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const pluginCommands = useContributions('commands');
  const sessions = useProjects((s) => s.sessions);
  const byProject = useTabs((s) => s.byProject);
  const activeTabId = useTabs((s) => s.activeTabId);
  const coordinatorName = useDispatchName();
  const pickerOwner = usePickerRequest((s) => s.owner);

  const { threadRows, otherRows } = useMemo(() => {
    const projectName = new Map(sessions.map((s) => [s.id, s.name]));
    const threads = sessions.flatMap((s) => (byProject[s.id] ?? []).filter(isThread)).sort(byAttention);
    const threadRows: Row[] = threads.map((t) => {
      const project = projectName.get(t.sessionId) ?? '';
      return {
        key: `thread:${t.id}`, label: t.label, hint: project, match: `${project} ${t.label}`,
        icon: <StatusDot state={dotState(t.status)} size={8} />,
        // W2-F replaces this intent with `navigate`.
        run: () => { showThreads(); useUI.getState().requestOpenThread({ sessionId: t.sessionId, terminalId: t.id }); },
      };
    });
    const active = activeTabId && !isDispatchTab(activeTabId) ? findTerminal(byProject, activeTabId) : undefined;
    const activeRows: Row[] = active && isThread(active) ? [
      { key: 'active:stop', label: `Stop “${active.label}”`, hint: 'This thread', icon: <Stop size={ICON} />,
        // The same stop as the thread's own Stop: it ends the turn and keeps the thread.
        run: () => { api.interrupt(active.id).catch(() => useHint.getState().show('The thread could not be stopped.')); } },
      { key: 'active:restart', label: `Restart “${active.label}”`, hint: 'This thread', icon: <ArrowClockwise size={ICON} />, run: () => setConfirm({ kind: 'restart', thread: active }) },
      { key: 'active:archive', label: `Archive “${active.label}”`, hint: 'This thread', icon: <Archive size={ICON} />, run: () => setConfirm({ kind: 'archive', thread: active }) },
    ] : [];
    const otherRows: Row[] = [
      ...activeRows,
      ...sessions.map((s) => ({ key: `project:${s.id}`, label: s.name, hint: 'Project', icon: <Folder size={ICON} />, run: () => useUI.getState().requestOpenProject(s.id) })),
      ...sessions.map((s) => ({
        key: `coordinator:${s.id}`, label: coordinatorName, hint: s.name, match: `${s.name} ${coordinatorName}`, icon: <Network size={ICON} />,
        run: () => { showThreads(); useProjects.getState().setActive(s.id); useTabs.getState().openDispatch(s.id); },
      })),
      ...sessions.map((s) => ({ key: `new-thread:${s.id}`, label: `New thread in ${s.name}`, hint: 'Project', icon: <Plus size={ICON} />, run: () => usePickerRequest.getState().request(`${NEW_THREAD_OWNER}${s.id}`) })),
      ...VIEW_ROWS.map(({ view, label, icon }) => ({ key: `view:${view}`, label, hint: 'View', icon, run: () => useUI.getState().setView(view) })),
      ...SETTINGS_SECTIONS.map((s) => ({ key: `settings:${s.key}`, label: s.label, hint: 'Settings', icon: <s.icon size={ICON} />, run: () => useUI.getState().requestSettings(s.key) })),
      ...pluginCommands.map((c) => ({ key: `plugin:${c.plugin}:${c.id}`, label: c.label, hint: c.plugin, icon: <PuzzlePiece size={ICON} />, run: c.run })),
    ];
    return { threadRows, otherRows };
  }, [sessions, byProject, activeTabId, coordinatorName, pluginCommands]);

  const shown = useMemo<Row[]>(() => {
    const needle = q.trim();
    if (!needle) return [...threadRows.slice(0, EMPTY_QUERY_THREADS), ...otherRows].slice(0, MAX_ROWS);
    // A row needs more than scattered letters: on average each letter starts a word or continues a run.
    const floor = needle.replace(/\s+/g, '').length * 2;
    const scored: { row: Row; score: number; i: number }[] = [];
    [...threadRows, ...otherRows].forEach((row, i) => {
      const onLabel = fuzzyScore(needle, row.label);
      const onMatch = row.match ? fuzzyScore(needle, row.match) : null;
      const score = Math.max(onLabel ?? -Infinity, onMatch === null ? -Infinity : onMatch - 2);
      if (score >= floor) scored.push({ row, score, i });
    });
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    return scored.slice(0, MAX_ROWS).map((s) => s.row);
  }, [threadRows, otherRows, q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!primaryMod(e) || e.key.toLowerCase() !== 'k') return;
      // Inside a terminal the key belongs to the shell (^K) — never both.
      if (document.activeElement?.closest?.('.xterm')) return;
      e.preventDefault(); setOpen((o) => !o); setQ(''); setCursor(0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  // The sidebar loads a project's threads when the project opens. The palette lists every project,
  // so it loads the ones that are still missing. A read only: nothing is created.
  useEffect(() => {
    if (!open) return;
    const tabs = useTabs.getState();
    for (const s of useProjects.getState().sessions) if (!tabs.byProject[s.id]) void tabs.loadTabs(s.id).catch(() => {});
  }, [open]);
  const activeKey = shown[Math.min(cursor, shown.length - 1)]?.key;
  // Keep the active option in view while Up and Down move it.
  useEffect(() => {
    if (!open || !activeKey) return;
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, activeKey]);

  const pick = (r: Row) => { setOpen(false); try { r.run(); } catch (e) { console.error('[command]', e); } };
  const optionId = (key: string) => `command-option-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const newThreadProject = pickerOwner?.startsWith(NEW_THREAD_OWNER) ? pickerOwner.slice(NEW_THREAD_OWNER.length) : null;

  const runConfirmed = () => {
    if (!confirm) return;
    const { kind, thread } = confirm;
    setConfirm(null);
    if (kind === 'archive') {
      api.archiveTerminal(thread.id).then(() => useTabs.getState().loadTabs(thread.sessionId)).catch(() => useHint.getState().show('The thread could not be archived.'));
    } else {
      api.relaunchTerminal(thread.id).catch((e) => useHint.getState().show(e instanceof Error ? `Could not restart: ${e.message}` : 'The thread could not be restarted.'));
    }
  };

  return (
    <>
      {open && (
        <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'var(--color-overlay)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '14vh' }}>
          <div role="dialog" aria-modal="true" aria-label="Commands" onClick={(e) => e.stopPropagation()} style={{ width: 'min(600px, 92vw)', background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-xl)', boxShadow: '0 20px 60px var(--color-shadow)', overflow: 'hidden' }}>
            <input ref={input} role="combobox" aria-label="Command" aria-expanded="true" aria-controls="command-list" aria-autocomplete="list"
              aria-activedescendant={activeKey ? optionId(activeKey) : undefined}
              value={q} placeholder="Search threads, projects and commands…"
              onChange={(e) => { setQ(e.target.value); setCursor(0); }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
                else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, shown.length - 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
                else if (e.key === 'Enter') { e.preventDefault(); const r = shown[cursor]; if (r) pick(r); }
              }}
              style={{ width: '100%', boxSizing: 'border-box', padding: '14px 16px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-primary)', fontSize: 15, outline: 'none' }} />
            <ul ref={list} id="command-list" role="listbox" aria-label="Results" style={{ listStyle: 'none', margin: 0, padding: 6, maxHeight: '50vh', overflowY: 'auto' }}>
              {shown.length === 0 && <li style={{ padding: '10px 12px', fontSize: 13, color: 'var(--color-text-tertiary)' }}>No thread, project or command matches.</li>}
              {shown.map((r, i) => (
                <li key={r.key} id={optionId(r.key)} role="option" aria-label={r.label} aria-selected={i === cursor} onMouseMove={() => { if (i !== cursor) setCursor(i); }} onClick={() => pick(r)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 'var(--radius-md)', cursor: 'pointer', background: i === cursor ? 'var(--color-elevated)' : 'transparent', color: 'var(--color-text-primary)', fontSize: 14 }}>
                  <span aria-hidden={r.key.startsWith('thread:') ? undefined : true} style={{ width: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: 'var(--color-text-tertiary)' }}>{r.icon}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
                  <span style={{ flexShrink: 0, maxWidth: '40%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{r.hint}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {/* The thread picker that "New thread in <project>" asks for. The person creates the thread here. */}
      {newThreadProject && (
        <NewThreadModal
          sessionId={newThreadProject}
          onClose={() => usePickerRequest.getState().clear()}
          onCreated={(id) => { showThreads(); useUI.getState().requestOpenThread({ sessionId: newThreadProject, terminalId: id }); }}
        />
      )}
      <ConfirmModal
        open={!!confirm}
        title={confirm?.kind === 'restart' ? 'Restart thread?' : 'Archive thread?'}
        message={!confirm ? ''
          : confirm.kind === 'restart' ? `“${confirm.thread.label}” will stop and start again. A turn that runs now is lost.`
          : `“${confirm.thread.label}” will be archived. You can restore it later from the archive.`}
        confirmLabel={confirm?.kind === 'restart' ? 'Restart' : 'Archive'}
        danger={confirm?.kind === 'archive'}
        onConfirm={runConfirmed}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}
