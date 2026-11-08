import { useEffect, useRef, useState } from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useMobileNav, openSettingsSubPage, closeSettingsSubPage, retitleSettingsSubPage, subPageOfState } from '../../stores/mobileNav';

/**
 * Which item's page a settings section shows (2026-11-07): an account, a harness, a skill, a device,
 * an integration, a plugin. One hook for every section.
 *
 * Desktop: plain state, closed by the page's own back link (`backLink` is true).
 * Phone: the page is one history entry above the section (stores/mobileNav), so the app header's
 * back arrow and the edge swipe close it; the header shows the `title` given to `open`, and the
 * Settings tab brings the page back after a visit to another tab. The page has no back link of its
 * own there (`backLink` is false).
 *
 * `retitle` renames the open page in the phone header (after a rename on the page itself).
 * `top` goes on the section's outer element: a page opens at its top.
 */
export function useSubPage(section: string) {
  const isMobile = useIsMobile();
  const [deskId, setDeskId] = useState<string | null>(null);
  const phoneId = useMobileNav((s) => (s.sub?.section === section ? s.sub.id : null));
  const openId = isMobile ? phoneId : deskId;
  const top = useRef<HTMLDivElement>(null);

  // The phone: history is the truth. A section that mounts on its page's entry shows the page, and
  // back (outside MobileApp too) closes it.
  useEffect(() => {
    if (!isMobile) return;
    const sync = (state: unknown) => {
      const sub = subPageOfState(state);
      const cur = useMobileNav.getState().sub;
      if (sub?.section === section) { if (cur?.section !== section || cur.id !== sub.id) useMobileNav.getState().setSub(sub); }
      else if (cur?.section === section) useMobileNav.getState().setSub(null);
    };
    sync(history.state);
    const onPop = (e: PopStateEvent) => sync(e.state);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [isMobile, section]);

  useEffect(() => { scrollParentToTop(top.current); }, [openId]);

  const open = (id: string, title?: string | null) => {
    if (isMobile) openSettingsSubPage(section, id, title);
    else setDeskId(id);
  };
  const close = () => {
    if (isMobile) closeSettingsSubPage();
    else setDeskId(null);
  };
  const retitle = (title: string) => { if (isMobile) retitleSettingsSubPage(title); };
  return { openId, open, close, retitle, isMobile, backLink: !isMobile, top };
}

/** Scrolls the nearest scrolling parent of `el` back to its top (a page opens at its top). */
export function scrollParentToTop(el: HTMLElement | null) {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) { p.scrollTop = 0; return; }
  }
}
