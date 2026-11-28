import { useEndless } from '../../stores/endless';
import { useThreadStatus } from '../../stores/threadStatus';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useNow } from '../../hooks/useNow';
import type { EndlessPaneState, EndlessPaneThread } from '../../api/types';
import { Spinner } from '../common/Spinner';
import { ThreadRow } from './ProjectsPanel';
import { AgentThreadGlyph } from './AgentThreadGlyph';
import { formatStart } from './paneParts';
import { harnessShort } from './harness';
import { stateFromStatus } from './threadView';
import { openThreadInPlace } from './openThread';
import { fontVar } from '../../lib/fontSize';

export interface ChatThread extends EndlessPaneThread { live: EndlessPaneState }
export interface ChatThreadGroups { needs: ChatThread[]; running: ChatThread[]; queued: ChatThread[]; finished: ChatThread[] }

const at = (t: EndlessPaneThread) => (t.lastActivityAt ? Date.parse(t.lastActivityAt) : 0) || Date.parse(t.startedAt) || 0;

/**
 * The threads that Chat started (`startedBy: 'chat'`, which includes the threads those threads started),
 * grouped by their LIVE state: the status events are newer than the pane rows, so a thread leaves
 * "running" the moment it stops.
 */
export function useChatThreads(): ChatThreadGroups {
  const threads = useEndless((s) => s.threads);
  const live = useThreadStatus((s) => s.byTerminal);
  const groups: ChatThreadGroups = { needs: [], running: [], queued: [], finished: [] };
  for (const t of [...threads].filter((x) => x.startedBy === 'chat').sort((a, b) => at(b) - at(a))) {
    const state: EndlessPaneState = stateFromStatus(live[t.id]?.status, live[t.id]?.threadStatus, t.state) ?? t.state;
    const row = { ...t, live: state };
    if (state === 'needs_you') groups.needs.push(row);
    else if (state === 'working') groups.running.push(row);
    else if (state === 'queued') groups.queued.push(row);
    else groups.finished.push(row);
  }
  return groups;
}

export const threadCount = (n: number) => `${n} thread${n === 1 ? '' : 's'}`;

/** "<1 min", "12 min", "2 h 5 min": how long a thread has run. */
export function ranFor(startedAt: string, now: number): string {
  const min = Math.floor((now - Date.parse(startedAt)) / 60_000);
  if (!Number.isFinite(min) || min < 1) return '<1 min';
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/**
 * The second line of a row. It says only what the section heading does not: every row here was started
 * by Chat, and Claude is the usual harness, so neither is named.
 */
export function chatRowMeta(t: ChatThread, project: string | undefined, now: number): { text: string; color?: string } {
  const other = t.harness === 'claude-code' ? null : harnessShort(t.harness);
  const state = t.live === 'needs_you' ? 'waiting on you'
    : t.live === 'working' ? ranFor(t.startedAt, now)
    : t.live === 'queued' ? null
    : t.live === 'error' ? 'stopped with an error'
    : t.lastActivityAt ? `finished ${formatStart(t.lastActivityAt, now)}` : null;
  const color = t.live === 'needs_you' ? 'var(--color-status-yellow)' : t.live === 'error' ? 'var(--color-status-red)' : undefined;
  return { text: [project, other, state].filter(Boolean).join(' · '), color };
}

const heading: React.CSSProperties = { font: `600 ${fontVar(12)} var(--font-sans)`, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-text-secondary)', marginTop: 4 };

/** The ONE list of Chat's threads: the right column on the desktop, a sheet on the phone. */
export function ChatThreadsList({ onNavigate }: { onNavigate?: () => void }) {
  const mobile = useIsMobile();
  const now = useNow(30_000);
  const projects = useEndless((s) => s.projects);
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const g = useChatThreads();
  const sections: [string, ChatThread[]][] = [['Needs you', g.needs], ['Running', g.running], ['Queued', g.queued], ['Finished today', g.finished]];
  const shown = sections.filter(([, rows]) => rows.length > 0);
  const open = (t: EndlessPaneThread) => { onNavigate?.(); void openThreadInPlace(t.project, t.id); };
  return (
    <div data-testid="chat-threads" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {shown.length === 0 && <p style={{ margin: 0, padding: '12px 0', fontSize: fontVar(13), color: 'var(--color-text-secondary)' }}>Chat has not started a thread today.</p>}
      {shown.map(([name, rows]) => (
        <div key={name} style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ ...heading, color: name === 'Needs you' ? 'var(--color-status-yellow)' : heading.color }}>{name} · {rows.length}</div>
          {rows.map((t) => <ThreadRow key={t.id} t={t} onOpen={open} mobile={mobile} meta={chatRowMeta(t, names.get(t.project), now)} glyph={<AgentThreadGlyph harness={t.harness} structured={t.structured} mobile={mobile} />} />)}
        </div>
      ))}
    </div>
  );
}

/** Over the bottom right of the messages while a thread that Chat started runs: a spinner and the count. */
export function RunningPill({ onOpen }: { onOpen?: () => void }) {
  const { running } = useChatThreads();
  const mobile = useIsMobile();
  if (running.length === 0) return null;
  return (
    <button type="button" data-testid="running-pill" aria-label={`${threadCount(running.length)} running`} onClick={onOpen}
      style={{ position: 'absolute', right: mobile ? 14 : 18, bottom: 12, zIndex: 5, height: mobile ? 40 : 34, padding: '0 14px 0 12px', display: 'flex', alignItems: 'center', gap: 8, borderRadius: 'var(--radius-pill)', border: '1px solid var(--color-border-strong)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', boxShadow: '0 8px 24px -8px var(--color-shadow-strong)', cursor: 'pointer', font: 'inherit', fontSize: fontVar(13), fontWeight: 600 }}>
      <Spinner size={14} />
      {threadCount(running.length)}
    </button>
  );
}
