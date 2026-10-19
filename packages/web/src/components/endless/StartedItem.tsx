import { ArrowRight, Warning } from '@phosphor-icons/react';
import { parseSpawn } from './spawn';
import { useThreadView } from './threadView';
import { StateMark, STATE_WORD } from './StateMark';
import { openThreadInPlace } from './openThread';
import { useEndless } from '../../stores/endless';
import { harnessShort } from './harness';
import { DocChip, docLinks } from './DocText';
import type { EndlessMessage, EndlessPaneState } from '../../api/types';

const WORD_COLOR: Record<EndlessPaneState, string> = {
  working: 'var(--color-accent)',
  needs_you: 'var(--color-status-yellow)',
  error: 'var(--color-status-red)',
  queued: 'var(--color-text-tertiary)',
  done: 'var(--color-text-tertiary)',
  idle: 'var(--color-text-tertiary)',
};

/** The Started card (spec 3.4, board ChatStates): one line; a second line only for doc chips (Task 10). */
export function StartedItem({ tool, echo }: { tool: EndlessMessage; echo?: EndlessMessage }) {
  const s = parseSpawn(tool, echo);
  const view = useThreadView(s.kind === 'started' ? s.agentId : null);
  const projects = useEndless((st) => st.projects);
  const line: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, overflow: 'hidden', minHeight: 32, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-pane)', font: '400 12.5px var(--font-sans)', color: 'var(--color-text-secondary)', textAlign: 'left', width: '100%' };
  const chip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 20, padding: '0 7px', borderRadius: 5, background: 'var(--color-elevated)', border: '1px solid var(--color-border)', font: '400 11px var(--font-mono)', flexShrink: 0 };
  if (s.kind === 'starting') return <div aria-busy="true" style={{ ...line, opacity: 0.6 }}><StateMark state="queued" decorative /><span>Starting</span><span style={{ color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span></div>;
  if (s.kind === 'failed') return <div role="alert" style={{ ...line, borderColor: 'var(--color-status-red)' }}><Warning size={13} color="var(--color-status-red)" aria-hidden="true" /><span style={{ color: 'var(--color-status-red)' }}>Could not start</span><span style={{ color: 'var(--color-text-primary)' }}>{s.name}</span><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.error}</span></div>;
  const projectId = s.projectId ?? projects.find((p) => p.name === s.projectName)?.id ?? null;
  const harness = view.row ? harnessShort(view.row.harness) : null;
  // Spec section 15: at most 2 doc chips from the task, on a second line; the card is otherwise one line.
  const docs = docLinks(s.task, projectId, projects).filter((d, k, all) => all.findIndex((o) => o.path === d.path) === k).slice(0, 2);
  const card = (
    <button type="button" disabled={!projectId} onClick={() => projectId && void openThreadInPlace(projectId, s.agentId)} style={{ ...line, cursor: projectId ? 'pointer' : 'default', ...(docs.length ? { border: 'none', background: 'none' } : {}) }}>
      <ArrowRight size={13} color="var(--color-text-tertiary)" aria-hidden="true" style={{ flexShrink: 0 }} />
      <span style={{ flexShrink: 0 }}>Started</span>
      <span style={{ color: 'var(--color-text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{s.label}</span>
      <span style={{ font: '400 11.5px var(--font-mono)', color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1 }}>{[s.projectName, harness].filter(Boolean).join(' · ')}</span>
      <span style={{ flex: 1 }} />
      {view.state && <span style={chip}><StateMark state={view.state} decorative /><span style={{ color: WORD_COLOR[view.state] }}>{STATE_WORD[view.state]}</span></span>}
    </button>
  );
  if (!docs.length) return card;
  return (
    <div style={{ minWidth: 0, borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-pane)' }}>
      {card}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, minWidth: 0, padding: '0 10px 7px 31px' }}>
        {docs.map((d) => <DocChip key={d.start} span={d} project={projectId} />)}
      </div>
    </div>
  );
}
