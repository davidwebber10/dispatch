import { useMemo } from 'react';
import { usePluginRegistry, useContributions } from './registry';
import { useUI } from '../stores/ui';
import { PluginBoundary } from './PluginBoundary';

/** A plugin's screen, by its view key (`plugin:<plugin>:<view>`). */
export function PluginView({ viewKey }: { viewKey: string }) {
  const view = usePluginRegistry((s) => s.views.find((v) => v.key === viewKey));
  const status = usePluginRegistry((s) => (view ? s.status[view.plugin] : undefined));
  if (!view) {
    return (
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
        <span>This plugin screen is not loaded.</span>
        <button type="button" onClick={() => useUI.getState().setView('workspace')} style={{ height: 30, padding: '0 12px', background: 'transparent', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer' }}>Back to Threads</button>
      </div>
    );
  }
  const C = view.Component;
  return (
    <div data-testid="plugin-view" data-plugin={view.plugin} style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
      <PluginBoundary plugin={view.plugin} resetKey={status?.at}><C /></PluginBoundary>
    </div>
  );
}

/**
 * A named place in an existing screen that plugins can fill (section 2.3's table). Every
 * content renders, higher `priority` first, then registration order; each in its own boundary.
 */
export function Slot({ name, ...props }: { name: string } & Record<string, unknown>) {
  const all = useContributions('slots');
  const mine = useMemo(() => all.filter((x) => x.slot === name).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)), [all, name]);
  if (mine.length === 0) return null;
  return (
    <>
      {mine.map((x) => {
        const C = x.Component;
        return <PluginBoundary key={`${x.plugin}:${x.id}`} plugin={x.plugin}><C {...props} /></PluginBoundary>;
      })}
    </>
  );
}
