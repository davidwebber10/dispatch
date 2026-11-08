import { useEffect, useState } from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';

type NavState = { settingsSection?: string; subPage?: string; depth?: number } | null;

function subPageOf(section: string): string | null {
  try {
    const s = history.state as NavState;
    return s?.settingsSection === section && s.subPage ? s.subPage : null;
  } catch { return null; }
}

/**
 * The page of one item in a settings list (a device, a skill), for a section that keeps its own
 * open state (2026-11-07, docs/design/settings-layout.md section 3).
 *
 * Desktop: plain state; the sub-page's "‹ Section" link calls `close`.
 * Phone: opening pushes one history entry above the section (the shape stores/mobileNav uses for a
 * plugin's page), so the app header's back button and the edge swipe close the page; `close` pops
 * that entry. The phone leaves the back link out (`backLink` is false), as the guide says.
 */
export function useSectionSubPage(section: string) {
  const isMobile = useIsMobile();
  const [openId, setOpenId] = useState<string | null>(() => (isMobile ? subPageOf(section) : null));

  useEffect(() => {
    if (!isMobile) return;
    const onPop = () => setOpenId(subPageOf(section));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [isMobile, section]);

  // A newly opened page starts at its top, wherever the list was scrolled.
  useEffect(() => {
    if (!openId) return;
    const el = document.querySelector('[data-subpage-top]');
    if (el && typeof (el as HTMLElement).scrollIntoView === 'function') (el as HTMLElement).scrollIntoView({ block: 'start' });
  }, [openId]);

  const open = (id: string) => {
    if (isMobile) {
      const depth = ((history.state as NavState)?.depth ?? 0) + 1;
      history.pushState({ nav: 1, settingsSection: section, subPage: id, depth }, '', location.pathname);
    }
    setOpenId(id);
  };
  const close = () => {
    if (isMobile && subPageOf(section)) { history.back(); return; }
    setOpenId(null);
  };
  return { openId, open, close, isMobile, backLink: !isMobile };
}
