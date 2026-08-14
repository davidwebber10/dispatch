import { useEffect } from 'react';
import { DetailsPane } from './DetailsPane';
import { FilesPane } from './FilesPane';
import { useUI } from '../../stores/ui';
import { useGitStatus, gitStatusFor } from '../../stores/gitStatus';

export function Inspector({ projectId, terminalId, onOpenFile, detailsSlot }: { projectId: string | null; terminalId: string | null; onOpenFile: (terminalId: string) => void; detailsSlot?: React.ReactNode }) {
  const tab = useUI((s) => s.inspectorTab);
  const setTab = useUI((s) => s.setInspectorTab);
  const changedCount = useGitStatus((s) => gitStatusFor(s.byProject, projectId).count);

  // The Files-tab badge must be right even while Details is showing, so the git
  // state loads on project switch here — not only inside FilesPane.
  useEffect(() => {
    if (projectId) void useGitStatus.getState().refresh(projectId);
  }, [projectId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', height: 40, flexShrink: 0, borderBottom: '1px solid var(--color-border)' }}>
        {(['details', 'files'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex: 1, background: 'transparent', border: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            borderBottom: tab === t ? '2px solid var(--color-accent)' : '2px solid transparent',
            color: tab === t ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
            fontSize: 13, fontWeight: tab === t ? 500 : 400, cursor: 'pointer', textTransform: 'capitalize',
          }}>
            {t}
            {t === 'files' && changedCount > 0 && (
              <span title={`${changedCount} uncommitted change${changedCount === 1 ? '' : 's'}`} style={{
                font: '700 10px var(--font-mono)', color: '#0A0A0B', background: 'var(--color-status-yellow)',
                borderRadius: 8, padding: '0 5px', lineHeight: '14px',
              }}>{changedCount}</span>
            )}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'details' ? (detailsSlot ?? <DetailsPane projectId={projectId} terminalId={terminalId} />) : <FilesPane projectId={projectId} onOpenFile={onOpenFile} />}
      </div>
    </div>
  );
}
