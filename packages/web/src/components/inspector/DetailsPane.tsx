import { api } from '../../api/client';
import { useProjects } from '../../stores/projects';
import { useActivity } from '../../stores/activity';
import { useTabs } from '../../stores/tabs';

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0' }}>
      <span style={{ color: 'var(--color-text-secondary)' }}>{label}</span>
      <span style={{ fontFamily: mono ? 'var(--font-mono)' : undefined, color: 'var(--color-text-primary)', fontSize: mono ? 11 : 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{value}</span>
    </div>
  );
}

const label: React.CSSProperties = { font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)' };
const btn: React.CSSProperties = { height: 30, padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7, color: 'var(--color-text-primary)', fontSize: 12, cursor: 'pointer' };

export function DetailsPane({ projectId, terminalId }: { projectId: string | null; terminalId: string | null }) {
  const project = useProjects((s) => s.sessions.find((x) => x.id === projectId)) ?? null;
  const activity = useActivity((s) => (terminalId ? s.byTerminal[terminalId] : undefined));

  if (!project) return <div style={{ padding: 12, color: 'var(--color-text-tertiary)' }}>No project selected</div>;
  return (
    <div style={{ padding: 12, fontSize: 13 }}>
      {(activity?.model || activity?.tokens || activity?.cost) && (
        <>
          <div style={{ ...label, marginBottom: 8 }}>THREAD DETAILS</div>
          {activity?.model && <Row label="Model" value={activity.model} />}
          {activity?.context && <Row label="Context" value={activity.context} />}
          {activity?.tokens && <Row label="Tokens" value={activity.tokens} />}
          {activity?.cost && <Row label="Cost" value={activity.cost} />}
        </>
      )}
      <div style={{ ...label, margin: '14px 0 8px' }}>PROJECT</div>
      <Row label="Name" value={project.name} />
      <Row label="Directory" value={project.workingDir} mono />
      <Row label="Provider" value={project.provider} />
      <Row label="Status" value={project.status} />
      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        {terminalId && <button onClick={() => { useTabs.getState().markLoading(terminalId); void api.relaunchTerminal(terminalId); }} style={btn}>Reload Thread</button>}
        {terminalId && <button onClick={() => void api.archiveTerminal(terminalId)} style={btn}>Archive Thread</button>}
      </div>
    </div>
  );
}
