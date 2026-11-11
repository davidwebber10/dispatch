import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { Terminal } from '../api/types';
import { useContributions, type InspectorTabCtx, type MenuBadge, type ThreadMenuCtx } from './registry';

const NONE = () => () => {};
const ZERO = () => 0;

/** One menu item's live count (2026-11-07): Previews' new previews for the thread's project. */
export function useMenuBadge<C>(badge: MenuBadge<C> | undefined, ctx: C): number {
  const sub = useMemo(() => (badge ? (cb: () => void) => badge.subscribe(cb) : NONE), [badge]);
  return useSyncExternalStore(sub, badge ? () => safeGet(badge, ctx) : ZERO, ZERO);
}

function safeGet<C>(b: MenuBadge<C>, ctx: C): number {
  try { const n = b.get(ctx); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; } catch { return 0; }
}

/**
 * The sum of the thread menu's item counts for one thread: the ⋯ button shows a dot when it is
 * above 0 (owner, 2026-11-07: the Previews eye left the thread header; ⋯ says a new preview waits).
 */
export function useThreadMenuBadge(tab: Terminal | null | undefined): number {
  const items = useContributions('threadMenu');
  // v4.5.2: the right-column tabs count too (they are rows of the phone's thread menu). v4.5.0 moved
  // Previews from a thread-menu item to a tab, and the dot was gone.
  const tabs = useContributions('inspectorTabs');
  const ctx = useMemo<ThreadMenuCtx | null>(() => (tab ? { tab } : null), [tab]);
  const tabCtx = useMemo<InspectorTabCtx | null>(() => (tab ? { terminalId: tab.id, sessionId: tab.sessionId ?? null } : null), [tab]);
  const sources = useMemo(
    () => (ctx ? items.filter((i) => i.badge && (!i.when || safeWhen(i.when, ctx))).map((i) => i.badge as MenuBadge<ThreadMenuCtx>) : []),
    [items, ctx],
  );
  const tabSources = useMemo(() => tabs.filter((t) => t.badge).map((t) => t.badge as MenuBadge<InspectorTabCtx>), [tabs]);
  const subscribe = useCallback((cb: () => void) => {
    const offs = [...sources.map((s) => s.subscribe(cb)), ...tabSources.map((s) => s.subscribe(cb))];
    return () => offs.forEach((off) => off());
  }, [sources, tabSources]);
  const get = useCallback(() => (ctx && tabCtx
    ? sources.reduce((n, s) => n + safeGet(s, ctx), 0) + tabSources.reduce((n, s) => n + safeGet(s, tabCtx), 0)
    : 0), [sources, tabSources, ctx, tabCtx]);
  return useSyncExternalStore(subscribe, get, ZERO);
}

function safeWhen(when: (c: ThreadMenuCtx) => boolean, ctx: ThreadMenuCtx): boolean {
  try { return when(ctx); } catch { return false; }
}

/** The count on a menu row: a small accent pill, hidden at 0. */
export function MenuBadgeCount<C>({ badge, ctx }: { badge?: MenuBadge<C>; ctx: C }) {
  const n = useMenuBadge(badge, ctx);
  if (!n) return null;
  return (
    <span aria-label={`${n} new`} style={{ marginLeft: 'auto', minWidth: 18, height: 18, padding: '0 6px', borderRadius: 'var(--radius-pill)', background: 'var(--color-accent)', color: 'var(--color-on-accent)', font: '700 11px var(--font-sans)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      {n > 99 ? '99+' : n}
    </span>
  );
}
