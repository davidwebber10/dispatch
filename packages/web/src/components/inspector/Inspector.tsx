import { DetailsPane } from './DetailsPane';
import { FilesPane } from './FilesPane';
import { useUI } from '../../stores/ui';

export function Inspector({ projectId, terminalId, onOpenFile, detailsSlot }: { projectId: string | null; terminalId: string | null; onOpenFile: (terminalId: string) => void; detailsSlot?: React.ReactNode }) {
  const tab = useUI((s) => s.inspectorTab);
  const setTab = useUI((s) => s.setInspectorTab);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', height: 40, flexShrink: 0, borderBottom: '1px solid var(--color-border)' }}>
        {(['details', 'files'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex: 1, background: 'transparent', border: 'none',
            borderBottom: tab === t ? '2px solid var(--color-accent)' : '2px solid transparent',
            color: tab === t ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
            fontSize: 13, fontWeight: tab === t ? 500 : 400, cursor: 'pointer', textTransform: 'capitalize',
          }}>{t}</button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'details' ? (detailsSlot ?? <DetailsPane projectId={projectId} terminalId={terminalId} />) : <FilesPane projectId={projectId} onOpenFile={onOpenFile} />}
      </div>
    </div>
  );
}
