import { useEffect, useRef, useState } from 'react';
import { ArrowClockwise, CaretDown, CaretRight, Check, Info, Warning } from '@phosphor-icons/react';
import { paneShows, useEndless } from '../../stores/endless';
import { useThreadStatus } from '../../stores/threadStatus';
import { useIsMobile } from '../../hooks/useIsMobile';
import type { EndlessPaneState, EndlessPaneThread, EndlessProject } from '../../api/types';
import { StateMark } from './StateMark';
import { harnessShort } from './harness';
import { openThreadInPlace } from './openThread';
import { stateFromStatus, useThreadView } from './threadView';
import { DocsFold } from './DocsFold';

/** The Chat right pane (spec 3.2): per project, the counts and a quiet list of recent threads.
 * Waiting threads come first, finished ones fold under "Done today (N)". */
const MIN_SPIN_MS = 400;
export const PANE_ROWS = 6;
const RANK: Record<EndlessPaneState, number> = { needs_you: 0, working: 1, queued: 2, error: 3, done: 4, idle: 4 };
const ORIGIN: Record<EndlessPaneThread['startedBy'], string> = { chat: 'Chat', overseer: 'Overseer', user: 'You', role: 'Role', thread: '' };

const activityOf = (t: EndlessPaneThread) => (t.lastActivityAt ? Date.parse(t.lastActivityAt) : 0) || Date.parse(t.startedAt) || 0;

/** Waiting projects first, then live, then the rest; inside each group the newest thread activity first. */
export function orderProjects(projects: EndlessProject[], threads: EndlessPaneThread[]): EndlessProject[] {
  const newest = (id: string) => Math.max(0, ...threads.filter((t) => t.project === id).map((t) => (t.lastActivityAt ? Date.parse(t.lastActivityAt) || 0 : 0)));
  const group = (p: EndlessProject) => (p.needsYou > 0 ? 0 : p.live > 0 ? 1 : 2);
  return [...projects].sort((a, b) => group(a) - group(b) || newest(b.id) - newest(a.id));
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14:02" today, "Sat 14:02" this week, "1 Sep" before that. Fixed names: ICU builds differ ("Sep" or "Sept"). */
export function formatStart(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(d)) / 86_400_000);
  if (days === 0) return hm;
  if (days > 0 && days < 7) return `${WEEKDAY[d.getDay()]} ${hm}`;
  return `${d.getDate()} ${MONTH[d.getMonth()]}`;
}

function originText(t: EndlessPaneThread): string {
  if (t.startedBy === 'thread') return t.via ? `via ${t.via}` : 'via a thread';
  if (t.startedBy === 'chat' && t.via) return `Chat, via ${t.via}`;
  return ORIGIN[t.startedBy] ?? '';
}

const label: React.CSSProperties = { font: '600 12px var(--font-sans)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' };
const mono = (size: number, color = 'var(--color-text-tertiary)'): React.CSSProperties => ({ fontFamily: 'var(--font-mono)', fontSize: size, color });
const ellipsis: React.CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const card: React.CSSProperties = { background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 8 };

type Open = (t: EndlessPaneThread) => void;

/** One thread: line 1 state mark, name, start time; line 2 (mono) [project ·] origin · harness · step.
 * The Needs you card adds the question (3 lines) and the yellow left border. A row has no buttons inside. */
function ThreadRow({ t, onOpen, mobile, needCard = false, project }: { t: EndlessPaneThread; onOpen: Open; mobile: boolean; needCard?: boolean; project?: string }) {
  const view = useThreadView(t.id);
  const state = view.state ?? t.state;
  const step: { text: string; color?: string } | null =
    state === 'working' ? { text: view.activity || 'working' }
    : state === 'needs_you' ? (needCard ? null : { text: 'waiting on you', color: 'var(--color-status-yellow)' })
    : state === 'queued' ? { text: 'queued' }
    : state === 'error' ? { text: 'stopped with an error', color: 'var(--color-status-red)' }
    : { text: t.lastActivityAt ? `finished ${formatStart(t.lastActivityAt)}` : 'finished' };
  const parts = [project, originText(t), harnessShort(t.harness)].filter((x): x is string => !!x);
  const finished = state === 'done' || state === 'idle';
  return (
    <button type="button" data-testid={needCard ? `need-${t.id}` : `thread-${t.id}`} onClick={() => onOpen(t)}
      style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center', width: '100%', textAlign: 'left', cursor: 'pointer', color: 'var(--color-text-primary)', font: 'inherit',
        ...(needCard
          ? { ...card, borderLeft: '2px solid var(--color-status-yellow)', padding: '10px 12px', minHeight: mobile ? 44 : undefined }
          : { background: 'transparent', border: 0, padding: '6px 0', minHeight: mobile ? 48 : undefined, opacity: finished ? 0.6 : 1 }),
      }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', fontSize: mobile ? 13.5 : 13 }}>
        <StateMark state={state} />
        <span style={{ flex: 1, minWidth: 0, fontWeight: needCard ? 600 : undefined, ...ellipsis }}>{t.label}</span>
        <span style={{ ...mono(11.5), whiteSpace: 'nowrap' }}>{formatStart(t.startedAt)}</span>
      </span>
      <span style={{ display: 'block', width: '100%', ...mono(11.5), lineHeight: 1.6, paddingLeft: 16, ...ellipsis }}>
        {parts.join(' · ')}
        {step && <>{parts.length > 0 && ' · '}<span style={step.color ? { color: step.color } : undefined}>{step.text}</span></>}
      </span>
      {needCard && t.question && (
        <span style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: mobile ? 13 : 12.5, lineHeight: 1.5, marginTop: 6, paddingLeft: 16 }}>{t.question}</span>
      )}
    </button>
  );
}

/** The footer toggles of a project block ("+N more", "Done today (N)", "Docs (N)"). */
export function MoreButton({ children, onClick, expanded, mobile, first }: { children: React.ReactNode; onClick: () => void; expanded?: boolean; mobile: boolean; first: boolean }) {
  return (
    <button type="button" aria-expanded={expanded} onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'transparent', border: 0, cursor: 'pointer', textAlign: 'left',
        borderTop: first ? '1px solid var(--color-border)' : 0, marginTop: first ? 4 : 0,
        ...mono(12, expanded ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)'),
        ...(mobile ? { minHeight: 44, padding: 0 } : { padding: '7px 0 1px' }),
      }}>
      {children}
    </button>
  );
}

export function ProjectsPanel({ onNavigate }: { onNavigate?: () => void } = {}) {
  const [refreshing, setRefreshing] = useState(false);
  const [doneOpen, setDoneOpen] = useState<Record<string, boolean>>({});
  const [allOpen, setAllOpen] = useState<Record<string, boolean>>({});
  const mobile = useIsMobile();
  const mounted = useRef(true);
  const floorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (floorTimer.current) clearTimeout(floorTimer.current); };
  }, []);
  // Keep the spinner up for at least MIN_SPIN_MS so a fast refresh still shows feedback.
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    const floor = new Promise((r) => { floorTimer.current = setTimeout(r, MIN_SPIN_MS); });
    try { await useEndless.getState().loadProjects(); } catch { /* the store keeps the old list */ }
    await floor;
    if (mounted.current) setRefreshing(false);
  };
  const projects = useEndless((s) => s.projects);
  const threads = useEndless((s) => s.threads);
  const truncated = useEndless((s) => s.truncated);
  const unavailable = useEndless((s) => s.unavailable);
  const docCounts = useEndless((s) => s.docCounts);
  const live = useThreadStatus((s) => s.byTerminal);

  // Group with the live overlay too, so a row moves between sections as soon as its status changes.
  const stateOf = (t: EndlessPaneThread): EndlessPaneState => stateFromStatus(live[t.id]?.status, live[t.id]?.threadStatus, t.state) ?? t.state;
  const byRank = (a: EndlessPaneThread, b: EndlessPaneThread) => RANK[stateOf(a)] - RANK[stateOf(b)] || activityOf(b) - activityOf(a);
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const open: Open = (t) => { onNavigate?.(); void openThreadInPlace(t.project, t.id); };

  const needs = threads.filter((t) => stateOf(t) === 'needs_you').sort((a, b) => activityOf(b) - activityOf(a));
  const shown = orderProjects(projects, threads).filter((p) => paneShows(p, threads));

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={label}>Projects</span>
        <button type="button" aria-label="Refresh projects" aria-busy={refreshing} disabled={refreshing} onClick={() => void refresh()}
          style={{ opacity: refreshing ? 0.7 : 1, width: 28, height: 28, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-secondary)', cursor: refreshing ? 'default' : 'pointer' }}>
          <ArrowClockwise size={14} className={refreshing ? 'endless-spin' : undefined} />
        </button>
      </div>

      {shown.length === 0 && (
        <p role={unavailable ? 'alert' : undefined} style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--color-text-secondary)', padding: '16px 4px' }}>
          {unavailable && <Warning size={15} style={{ color: 'var(--color-status-red)', flexShrink: 0 }} />}
          {unavailable ? 'Projects are unavailable.' : 'No project activity yet.'}
        </p>
      )}

      {needs.length > 0 && (
        <div data-testid="needs-you" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ ...label, color: 'var(--color-status-yellow)' }}>Needs you · {needs.length}</div>
          {needs.map((t) => <ThreadRow key={t.id} t={t} onOpen={open} mobile={mobile} needCard project={names.get(t.project)} />)}
        </div>
      )}

      {shown.map((p) => {
        const mine = threads.filter((t) => t.project === p.id).sort(byRank);
        const active = mine.filter((t) => RANK[stateOf(t)] < 4);
        const done = mine.filter((t) => RANK[stateOf(t)] === 4);
        const visible = allOpen[p.id] ? active : active.slice(0, PANE_ROWS);
        const hidden = active.length - visible.length;
        const isDoneOpen = !!doneOpen[p.id];
        return (
          <div key={p.id} data-testid={`project-${p.id}`} style={{ ...card, padding: mobile ? '10px 12px 6px' : '10px 12px 8px', display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--color-text-primary)' }}>{p.name}</div>
            <div style={{ ...mono(12), lineHeight: 1.5 }}>
              {p.live} live · <span style={p.needsYou > 0 ? { color: 'var(--color-status-yellow)' } : undefined}>{p.needsYou} need you</span> · {p.openItems} open
            </div>
            {p.lastReport && (
              <div style={{ fontSize: 12.5, marginTop: 4, color: 'var(--color-text-secondary)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.lastReport}</div>
            )}
            {visible.length > 0 && (
              <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column' }}>
                {visible.map((t) => <ThreadRow key={t.id} t={t} onOpen={open} mobile={mobile} />)}
              </div>
            )}
            {hidden > 0 && (
              <MoreButton mobile={mobile} first onClick={() => setAllOpen((s) => ({ ...s, [p.id]: true }))}>
                +{hidden} more<span style={{ flex: 1 }} /><CaretDown size={12} aria-hidden />
              </MoreButton>
            )}
            {done.length > 0 && (
              <>
                <MoreButton mobile={mobile} first={hidden === 0} expanded={isDoneOpen} onClick={() => setDoneOpen((s) => ({ ...s, [p.id]: !s[p.id] }))}>
                  <Check size={12} aria-hidden />Done today ({done.length})<span style={{ flex: 1 }} />
                  {isDoneOpen ? <CaretDown size={12} aria-hidden /> : <CaretRight size={12} aria-hidden />}
                </MoreButton>
                {isDoneOpen && done.map((t) => <ThreadRow key={t.id} t={t} onOpen={open} mobile={mobile} />)}
              </>
            )}
            <DocsFold projectId={p.id} count={docCounts[p.id] ?? 0} onNavigate={onNavigate} first={hidden === 0 && done.length === 0} />
          </div>
        );
      })}

      {truncated && (
        <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '2px 2px 0', ...mono(11.5, 'var(--color-text-secondary)') }}>
          <Info size={13} aria-hidden style={{ flexShrink: 0 }} />Some projects are not shown
        </p>
      )}
    </div>
  );
}
