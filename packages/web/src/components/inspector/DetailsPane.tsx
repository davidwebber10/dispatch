import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useProjects } from '../../stores/projects';
import { useActivity } from '../../stores/activity';
import { useTabs, findTerminal } from '../../stores/tabs';
import type { Terminal } from '../../api/types';

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0' }}>
      <span style={{ color: 'var(--color-text-secondary)' }}>{label}</span>
      <span style={{ fontFamily: mono ? 'var(--font-mono)' : undefined, color: 'var(--color-text-primary)', fontSize: mono ? 11 : 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{value}</span>
    </div>
  );
}

function homePath(p: string): string {
  return (p || '').replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

const label: React.CSSProperties = { font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)' };
const btn: React.CSSProperties = { height: 30, padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7, color: 'var(--color-text-primary)', fontSize: 12, cursor: 'pointer' };

export function DetailsPane({ projectId, terminalId }: { projectId: string | null; terminalId: string | null }) {
  const project = useProjects((s) => s.sessions.find((x) => x.id === projectId)) ?? null;
  const activity = useActivity((s) => (terminalId ? s.byTerminal[terminalId] : undefined));
  const tab = useTabs((s) => (terminalId ? findTerminal(s.byProject, terminalId) : null));
  const [term, setTerm] = useState<Terminal | null>(null);
  const [branch, setBranch] = useState<string | null>(null);

  // The terminal's own working dir + pid — the data that used to live in the
  // bottom bar below the terminal, now surfaced here in the right column.
  useEffect(() => {
    let live = true; setTerm(null);
    if (terminalId) api.getTerminal(terminalId).then((t) => { if (live) setTerm(t); }).catch(() => {});
    return () => { live = false; };
  }, [terminalId]);

  useEffect(() => {
    let live = true; setBranch(null);
    if (projectId) api.getGitInfo(projectId).then((g) => { if (live) setBranch(g.branch); }).catch(() => {});
    return () => { live = false; };
  }, [projectId]);

  if (!project) return <div style={{ padding: 12, color: 'var(--color-text-tertiary)' }}>No project selected</div>;

  const hasActivity = !!(activity?.model || activity?.tokens || activity?.cost);
  const status = tab?.status ?? term?.status;
  return (
    <div style={{ padding: 12, fontSize: 13 }}>
      {hasActivity && (
        <>
          <div style={{ ...label, marginBottom: 8 }}>THREAD DETAILS</div>
          {activity?.model && <Row label="Model" value={activity.model} />}
          {activity?.context && <Row label="Context" value={activity.context} />}
          {activity?.tokens && <Row label="Tokens" value={activity.tokens} />}
          {activity?.cost && <Row label="Cost" value={activity.cost} />}
        </>
      )}
      {terminalId && (
        <>
          <div style={{ ...label, margin: hasActivity ? '14px 0 8px' : '0 0 8px' }}>THREAD</div>
          {tab?.label && <Row label="Name" value={tab.label} />}
          {term?.workingDir && <Row label="Directory" value={homePath(term.workingDir)} mono />}
          {branch && <Row label="Branch" value={`⎇ ${branch}`} mono />}
          {term?.pid != null && <Row label="PID" value={String(term.pid)} mono />}
          {status && <Row label="Status" value={status} />}
        </>
      )}
      <div style={{ ...label, margin: '14px 0 8px' }}>PROJECT</div>
      <Row label="Name" value={project.name} />
      <Row label="Directory" value={homePath(project.workingDir)} mono />
      <Row label="Provider" value={project.provider} />
      <Row label="Status" value={project.status} />
      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        {terminalId && <button onClick={() => { useTabs.getState().markLoading(terminalId); void api.relaunchTerminal(terminalId); }} style={btn}>Reload Thread</button>}
        {terminalId && <button onClick={() => void api.archiveTerminal(terminalId)} style={btn}>Archive Thread</button>}
      </div>
    </div>
  );
}
