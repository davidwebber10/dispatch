import { useEffect } from 'react';
import { DetailsPane } from './DetailsPane';
import { FilesPane } from './FilesPane';
import { useUI } from '../../stores/ui';
import { useGitStatus, gitStatusFor } from '../../stores/gitStatus';
import { usePluginRegistry, useInspectorTabs } from '../../plugins/registry';
import { PluginBoundary } from '../../plugins/PluginBoundary';
import { tabIcon } from '../../plugins/sdk';

const tabStyle = (on: boolean): React.CSSProperties => ({
  // Each tab is as wide as its name, then they share the rest (2026-11-09: four equal tabs cut "Previews").
  flex: '1 1 auto', minWidth: 0, background: 'transparent', border: 'none',
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '0 6px',
  borderBottom: on ? '2px solid var(--color-accent)' : '2px solid transparent',
  color: on ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
  fontSize: 13, fontWeight: on ? 500 : 400, cursor: 'pointer', whiteSpace: 'nowrap',
});

export function Inspector({ projectId, terminalId, onOpenFile, detailsSlot }: { projectId: string | null; terminalId: string | null; onOpenFile: (terminalId: string) => void; detailsSlot?: React.ReactNode }) {
  const selected = useUI((s) => s.inspectorTab);
  const setTab = useUI((s) => s.setInspectorTab);
  const changedCount = useGitStatus((s) => gitStatusFor(s.byProject, projectId).count);
  // Plugins' tabs (the `inspectorTabs` contribution), after Details and Files.
  const pluginTabs = useInspectorTabs();
  const pluginTab = pluginTabs.find((t) => t.key === selected);
  // A selected plugin tab that is gone shows Details; the choice resets unless the plugin is
  // only reloading (a file save unregisters, then registers again once the bundle loads).
  const missing = selected !== 'details' && selected !== 'files' && !pluginTab;
  const missingPlugin = missing ? selected.split(':')[1] : undefined;
  const reloading = usePluginRegistry((s) => (missingPlugin ? s.status[missingPlugin]?.state === 'loading' : false));
  const tab = missing ? 'details' : selected;
  const status = usePluginRegistry((s) => (pluginTab ? s.status[pluginTab.plugin] : undefined));

  useEffect(() => {
    if (missing && !reloading) setTab('details');
  }, [missing, reloading, setTab]);

  // The Files-tab badge must be right even while Details is showing, so the git
  // state loads on project switch here — not only inside FilesPane.
  useEffect(() => {
    if (projectId) void useGitStatus.getState().refresh(projectId);
  }, [projectId]);

  const PluginTab = pluginTab?.Component;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div role="tablist" aria-label="Right column" style={{ display: 'flex', height: 40, flexShrink: 0, borderBottom: '1px solid var(--color-border)', overflowX: 'auto' }}>
        {(['details', 'files'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} style={{ ...tabStyle(tab === t), textTransform: 'capitalize' }}>
            {t}
            {t === 'files' && changedCount > 0 && (
              <span title={`${changedCount} uncommitted change${changedCount === 1 ? '' : 's'}`} style={{
                font: '700 10px var(--font-mono)', color: 'var(--color-on-accent)', background: 'var(--color-status-yellow)',
                borderRadius: 'var(--radius-md)', padding: '0 5px', lineHeight: '14px',
              }}>{changedCount}</span>
            )}
          </button>
        ))}
        {pluginTabs.map((p) => {
          const Icon = tabIcon(p.icon);
          return (
            <button key={p.key} role="tab" aria-selected={tab === p.key} title={`${p.label} (${p.plugin})`} onClick={() => setTab(p.key as `plugin:${string}`)} style={tabStyle(tab === p.key)}>
              {p.icon && <Icon size={14} aria-hidden />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.label}</span>
            </button>
          );
        })}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {pluginTab && PluginTab ? (
          <PluginBoundary key={pluginTab.key} plugin={pluginTab.plugin} resetKey={status?.at}>
            <PluginTab terminalId={terminalId} sessionId={projectId} />
          </PluginBoundary>
        ) : tab === 'details' ? (detailsSlot ?? <DetailsPane projectId={projectId} terminalId={terminalId} />) : <FilesPane projectId={projectId} terminalId={terminalId} onOpenFile={onOpenFile} />}
      </div>
    </div>
  );
}
