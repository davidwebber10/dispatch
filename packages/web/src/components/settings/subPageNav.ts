import { useEffect, useState } from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';

/**
 * Which item's page a settings section shows (2026-11-07): a harness in Agents, an account in
 * Accounts. On the desktop it is plain state, closed by the page's own back link. On the phone the
 * page is one history entry above the section, the way Settings → Plugins does it: the app header's
 * back (history.back) and the edge swipe close it, and MobileApp keeps the section on screen because
 * the entry carries the section's own `settingsSection` and `nav` (it is a copy of the entry below).
 * The entry names the page as `settingsSub: "<section>:<id>"`.
 *
 * A candidate for promotion next to stores/mobileNav (then the phone header could name the page).
 */
export function useSubPage(section: string): { openId: string | null; open: (id: string) => void; close: () => void; isMobile: boolean } {
  const isMobile = useIsMobile();
  const [openId, setOpenId] = useState<string | null>(null);
  const prefix = `${section}:`;
  const fromState = (st: unknown): string | null => {
    const sub = (st as { settingsSub?: string } | null)?.settingsSub;
    return typeof sub === 'string' && sub.startsWith(prefix) ? sub.slice(prefix.length) : null;
  };

  useEffect(() => {
    if (!isMobile) return;
    const onPop = (e: PopStateEvent) => setOpenId(fromState(e.state));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [isMobile, prefix]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (id: string) => {
    if (isMobile) {
      const below = (history.state ?? {}) as Record<string, unknown>;
      const depth = ((below.depth as number | undefined) ?? 0) + 1;
      history.pushState({ ...below, settingsSub: `${prefix}${id}`, depth }, '', location.pathname);
    }
    setOpenId(id);
  };
  const close = () => {
    if (isMobile && fromState(history.state) !== null) { history.back(); return; }
    setOpenId(null);
  };
  return { openId, open, close, isMobile };
}

/** Scrolls the nearest scrolling parent of `el` back to its top (a page opens at its top). */
export function scrollParentToTop(el: HTMLElement | null) {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) { p.scrollTop = 0; return; }
  }
}
