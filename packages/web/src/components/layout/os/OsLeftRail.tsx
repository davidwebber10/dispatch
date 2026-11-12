import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChartBar, ChatCircleDots, Gear, Network, Sidebar as SidebarIcon, type Icon } from '@phosphor-icons/react';
import { useUI, type View } from '../../../stores/ui';
import { useProjects } from '../../../stores/projects';
import { useTabs } from '../../../stores/tabs';
import { useDispatchName } from '../../../stores/settings';
import { can } from '../../../lib/profile';
import { THREADS_ICON } from '../../common/viewIcons';
import { usePluginViews } from '../../../plugins/registry';
import { pluginIcon } from '../../../plugins/sdk';
import { OsAppSwitcher, OsSpotlight, useOsShell } from './OsAppSwitcher';
import { PRODUCT_ICON } from './OsIcon';
import './os-shell.css';

// OS LeftRail (explorer web/src/shell/LeftRail.tsx): 288px by default, drag to resize up to 520,
// below 160 it snaps to the 64px icon rail; a double-click or the bottom button toggles. Saved per browser.
const WIDTH_KEY = 'dispatch:osRailWidth';
const EXPANDED_KEY = 'dispatch:osRailExpandedWidth';
const WIDTH_MAX = 520;
const WIDTH_DEFAULT = 288;
const COLLAPSED = 64;
const SNAP = 160;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
function readWidth(key: string, lo: number): number {
  try { const n = Number(localStorage.getItem(key)); return Number.isFinite(n) && n > 0 ? clamp(n, lo, WIDTH_MAX) : WIDTH_DEFAULT; } catch { return WIDTH_DEFAULT; }
}

/** One row of the rail (OS RailItem): an 18px icon and a 15px label; on the 64px rail, a 40px icon button. */
export function OsRailItem({ icon: I, label, active, onSelect, collapsed, badge }: { icon: Icon; label: string; active?: boolean; onSelect: () => void; collapsed?: boolean; badge?: number }) {
  return (
    <button type="button" onClick={onSelect} title={collapsed ? label : undefined} aria-label={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined} className={`os-item${collapsed ? ' os-collapsed' : ''}`}>
      <I className="os-item-icon" />
      {!collapsed && <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>}
      {!collapsed && !!badge && (
        <span style={{ marginLeft: 'auto', minWidth: 20, padding: '2px 6px', borderRadius: 'var(--radius-pill)', textAlign: 'center', font: '600 12px/16px var(--font-sans)', background: 'color-mix(in srgb, var(--color-status-amber) 22%, transparent)', color: 'var(--color-text-primary)' }}>{badge}</span>
      )}
    </button>
  );
}

/**
 * The left rail of a hosted workspace (and the business preview), in the look of Polywood OS: the app
 * switcher, the app's own navigation, then `sidebar` (Dispatch's Threads | Projects list) taking the
 * rest of the height, and at the bottom Settings and the collapse button. Entries follow the profile
 * feature map (lib/profile.ts).
 */
export function OsLeftRail({ sidebar }: { sidebar?: ReactNode }) {
  const view = useUI((s) => s.view);
  const setView = useUI((s) => s.setView);
  const activeProject = useProjects((s) => s.activeId);
  const dispatchName = useDispatchName();
  const pluginViews = usePluginViews();
  const shell = useOsShell();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [width, setWidth] = useState(() => readWidth(WIDTH_KEY, COLLAPSED));
  const [expanded, setExpanded] = useState(() => readWidth(EXPANDED_KEY, SNAP));
  const [dragging, setDragging] = useState(false);
  const collapsed = width < SNAP;
  const raf = useRef<number | null>(null);

  useEffect(() => { try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* private mode */ } if (width >= SNAP) setExpanded(width); }, [width]);
  useEffect(() => { try { localStorage.setItem(EXPANDED_KEY, String(expanded)); } catch { /* private mode */ } }, [expanded]);
  useEffect(() => { if (collapsed && switcherOpen) setSwitcherOpen(false); }, [collapsed, switcherOpen]);

  const toggle = () => setWidth(collapsed ? expanded : COLLAPSED);
  const startDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: PointerEvent) => {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(() => { const x = clamp(Math.round(ev.clientX), COLLAPSED, WIDTH_MAX); setWidth(x < SNAP ? COLLAPSED : x); });
    };
    const onUp = () => {
      setDragging(false);
      document.body.style.cursor = prevCursor;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  const go = (v: View) => setView(v);
  const nav: { key: string; icon: Icon; label: string; active: boolean; onSelect: () => void }[] = [
    { key: 'threads', icon: THREADS_ICON, label: 'Threads', active: view === 'workspace', onSelect: () => go('workspace') },
    ...(can('endless') ? [{ key: 'chat', icon: ChatCircleDots, label: 'Chat', active: view === 'chat', onSelect: () => go('chat') }] : []),
    ...(can('control-plane') && activeProject ? [{ key: 'control', icon: Network, label: dispatchName, active: false, onSelect: () => { go('workspace'); useTabs.getState().openDispatch(activeProject); } }] : []),
    ...(can('analytics') ? [{ key: 'analytics', icon: ChartBar, label: 'Analytics', active: view === 'analytics', onSelect: () => go('analytics') }] : []),
    ...(can('settings.plugins') ? pluginViews.map((v) => ({ key: v.key, icon: pluginIcon(v.icon), label: v.label, active: view === v.key, onSelect: () => go(v.key as View) })) : []),
  ];

  return (
    <aside aria-label="Navigation" style={{
      position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', flexShrink: 0, width,
      background: 'var(--color-pane)', borderRight: '1px solid var(--color-border)',
      transition: dragging ? 'none' : 'width .2s ease-out',
    }}>
      {collapsed ? (
        <div style={{ padding: 8, display: 'flex', justifyContent: 'center' }}>
          <button type="button" className="os-icon-btn" title="Expand sidebar" onClick={toggle} style={{ width: 40, height: 40 }}>
            <OsProductGlyph />
          </button>
        </div>
      ) : (
        <OsAppSwitcher shell={shell} open={switcherOpen} setOpen={setSwitcherOpen} />
      )}
      <OsSpotlight open={switcherOpen} />

      <nav aria-label="App" style={{ flexShrink: 0, padding: '8px 8px 4px', display: 'flex', flexDirection: 'column', alignItems: collapsed ? 'center' : 'stretch', gap: collapsed ? 6 : 2 }}>
        {nav.map((n) => <OsRailItem key={n.key} icon={n.icon} label={n.label} active={n.active} onSelect={n.onSelect} collapsed={collapsed} />)}
      </nav>

      {/* Dispatch's own list (Threads | Projects), under a hairline, absorbing the rest of the height. */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: collapsed ? 'none' : 'flex', flexDirection: 'column', borderTop: '1px solid var(--color-border)', marginTop: 4 }}>
        {sidebar}
      </div>
      {collapsed && <div style={{ flex: 1 }} />}

      <div style={{ flexShrink: 0, padding: 8, display: 'flex', flexDirection: collapsed ? 'column' : 'row', alignItems: 'center', gap: 4 }}>
        <div style={{ flex: collapsed ? undefined : 1, minWidth: 0 }}>
          <OsRailItem icon={Gear} label="Settings" active={view === 'settings'} onSelect={() => go('settings')} collapsed={collapsed} />
        </div>
        <button type="button" className="os-icon-btn" onClick={toggle} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          <SidebarIcon size={16} />
        </button>
      </div>

      <div role="separator" aria-orientation="vertical" aria-label={collapsed ? 'Drag to expand sidebar' : 'Resize sidebar'}
        className="os-resize" onPointerDown={startDrag} onDoubleClick={toggle}><div /></div>
    </aside>
  );
}

/** The current app's icon, 28px, as OS shows it on the collapsed rail. */
function OsProductGlyph() { const I = PRODUCT_ICON; return <I size={28} color="var(--color-text-primary)" />; }
