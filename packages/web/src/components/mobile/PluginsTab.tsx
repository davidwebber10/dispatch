import { CaretRight } from '@phosphor-icons/react';
import { usePluginRegistry, usePluginViews } from '../../plugins/registry';
import { pluginIcon } from '../../plugins/sdk';

/**
 * The phone's Plugins tab (docs/superpowers/specs/2026-11-07-plugins-design.md, section 2.5): every
 * plugin screen as a row; a tap opens it in place. Up to two screens the owner promoted in
 * Settings → Plugins have tabs of their own and do not repeat here.
 */
export function PluginsTab({ onOpen }: { onOpen: (viewKey: string) => void }) {
  const views = usePluginViews();
  const manifests = usePluginRegistry((s) => s.manifests);
  const promoted = usePluginRegistry((s) => s.promoted);
  const rows = views.filter((v) => !promoted.includes(v.key));
  const nameOf = (plugin: string) => manifests.find((m) => m.id === plugin)?.name ?? plugin;
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '4px 14px 16px' }}>
      <div style={{ font: '500 10.5px var(--font-mono)', letterSpacing: '0.12em', color: 'var(--color-text-tertiary)', padding: '18px 4px 8px' }}>PLUGIN SCREENS</div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--color-text-tertiary)', padding: '4px 4px 14px' }}>
          No plugin screens yet. A plugin that adds one shows here. Settings → Plugins lists what is installed.
        </div>
      ) : (
        <div style={{ background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
          {rows.map((v, i) => {
            const Icon = pluginIcon(v.icon);
            return (
              <button key={v.key} type="button" onClick={() => onOpen(v.key)}
                style={{ display: 'flex', alignItems: 'center', gap: 13, width: '100%', textAlign: 'left', padding: '12px 12px', background: 'transparent', border: 'none', borderTop: i > 0 ? '1px solid var(--color-border)' : 'none', cursor: 'pointer' }}>
                <span style={{ width: 30, height: 30, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-md)', background: 'var(--color-elevated)', border: '1px solid #2C2C32', color: 'var(--color-text-secondary)' }}>
                  <Icon size={17} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>{v.label}</span>
                  <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: 'var(--color-text-tertiary)' }}>{nameOf(v.plugin)}</span>
                </span>
                <CaretRight size={18} color="var(--color-text-tertiary)" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
