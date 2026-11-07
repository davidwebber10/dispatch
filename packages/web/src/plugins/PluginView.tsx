import { useMemo } from 'react';
import { usePluginRegistry, useContributions } from './registry';
import { PluginBoundary } from './PluginBoundary';

/** A plugin's screen, by its view key (`plugin:<plugin>:<view>`). */
export function PluginView({ viewKey }: { viewKey: string }) {
  const view = usePluginRegistry((s) => s.views.find((v) => v.key === viewKey));
  const status = usePluginRegistry((s) => (view ? s.status[view.plugin] : undefined));
  if (!view) {
    return <div style={{ padding: 24, color: 'var(--color-text-tertiary)', fontSize: 13 }}>This plugin screen is not loaded.</div>;
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
