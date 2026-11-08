import { CaretRight } from '@phosphor-icons/react';
import { usePluginRegistry, usePluginViews } from '../../plugins/registry';
import { pluginIcon } from '../../plugins/sdk';

/**
 * The phone's Plugins tab (docs/superpowers/specs/2026-11-07-plugins-design.md, section 2.5): a plain
 * list of plugin screens. A tap opens the screen under a thread-style header (back arrow, its name).
 * Up to two screens the owner promoted in Settings → Plugins have tabs of their own and do not
 * repeat here. Plugin commands live in the command palette, not here.
 */
export function PluginsTab({ onOpen }: { onOpen: (viewKey: string) => void }) {
  const views = usePluginViews();
  const manifests = usePluginRegistry((s) => s.manifests);
  const promoted = usePluginRegistry((s) => s.promoted);
  // What each plugin has new (2026-11-07): its count on its own row, so the tab's dot says where to look.
  const badges = usePluginRegistry((s) => s.badges);
  const rows = views.filter((v) => !promoted.includes(v.key));
  // A second line only when the plugin describes itself with something other than the row's name.
  const subtitleOf = (plugin: string, label: string) => {
    const d = manifests.find((m) => m.id === plugin)?.description?.trim();
    return d && d.toLowerCase() !== label.trim().toLowerCase() ? d : null;
  };
  if (rows.length === 0) {
    return <div style={{ padding: '20px 18px', fontSize: 14, color: 'var(--color-text-tertiary)' }}>No plugin has a screen yet.</div>;
  }
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y', padding: '6px 4px 12px' }}>
      {rows.map((v) => {
        const Icon = pluginIcon(v.icon);
        const sub = subtitleOf(v.plugin, v.label);
        return (
          <button key={v.key} type="button" onClick={() => onOpen(v.key)}
            style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '13px 12px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--color-border)', cursor: 'pointer' }}>
            <span aria-hidden style={{ width: 30, height: 30, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-md)', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', color: 'var(--color-text-secondary)' }}>
              <Icon size={17} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.label}</span>
              {sub && <span style={{ display: 'block', marginTop: 2, fontSize: 12.5, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</span>}
            </span>
            {(badges[v.key] ?? 0) > 0 && (
              <span aria-label={`${badges[v.key]} new`} style={{ minWidth: 20, height: 20, padding: '0 6px', borderRadius: 'var(--radius-pill)', background: 'var(--color-accent)', color: 'var(--color-on-accent)', font: '700 11.5px var(--font-sans)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {badges[v.key] > 99 ? '99+' : badges[v.key]}
              </span>
            )}
            <CaretRight size={18} color="var(--color-text-tertiary)" />
          </button>
        );
      })}
    </div>
  );
}
