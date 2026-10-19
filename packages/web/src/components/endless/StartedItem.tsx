import { Play } from '@phosphor-icons/react';
import { parseSpawn } from './EndlessMessageRow';
import { useThreadView } from './threadView';
import { StateMark, STATE_WORD } from './StateMark';
import { openThreadInPlace } from './openThread';
import { useEndless } from '../../stores/endless';
import { harnessShort } from './harness';
import type { EndlessMessage } from '../../api/types';

/** The Started card (spec 3.4, board ChatStates): one line; a second line only for doc chips (Task 10). */
export function StartedItem({ tool, echo }: { tool: EndlessMessage; echo?: EndlessMessage }) {
  const s = parseSpawn(tool, echo);
  const view = useThreadView(s.kind === 'started' ? s.agentId : null);
  const projects = useEndless((st) => st.projects);
  const line: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, minHeight: 32, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-pane)', font: '400 12.5px var(--font-sans)', color: 'var(--color-text-secondary)', textAlign: 'left', width: '100%' };
  if (s.kind === 'starting') return <div style={{ ...line, opacity: 0.6 }}><Play size={13} /><span>Starting</span><span style={{ color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span></div>;
  if (s.kind === 'failed') return <div role="alert" style={{ ...line, borderColor: 'var(--color-status-red)' }}><span style={{ color: 'var(--color-status-red)' }}>Could not start</span><span style={{ color: 'var(--color-text-primary)' }}>{s.name}</span><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.error}</span></div>;
  const projectId = s.projectId ?? projects.find((p) => p.name === s.projectName)?.id ?? null;
  const harness = view.row ? harnessShort(view.row.harness) : null;
  return (
    <button type="button" disabled={!projectId} onClick={() => projectId && void openThreadInPlace(projectId, s.agentId)} style={{ ...line, cursor: projectId ? 'pointer' : 'default' }}>
      <Play size={13} />
      <span>Started</span>
      <span style={{ color: 'var(--color-text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{s.label}</span>
      <span style={{ font: '400 11.5px var(--font-mono)', color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>{[s.projectName, harness].filter(Boolean).join(' · ')}</span>
      <span style={{ flex: 1 }} />
      {view.state && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '400 11px var(--font-mono)' }}><StateMark state={view.state} />{STATE_WORD[view.state]}</span>}
    </button>
  );
}
