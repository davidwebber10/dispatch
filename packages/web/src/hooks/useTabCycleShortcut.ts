import { useEffect } from 'react';
import { useTabs } from '../stores/tabs';

/* Ctrl+Tab / Ctrl+Shift+Tab cycles through open tabs (wrapping). Capture phase so
   it wins even when focus is inside an xterm terminal or a text input — safe to
   hijack because Ctrl+Tab never types a character. Note: a regular browser tab
   reserves Ctrl+Tab for its own tab switching; this fires where the page actually
   receives the key (installed/standalone PWA window). */
export function useTabCycleShortcut(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !e.ctrlKey || e.metaKey || e.altKey) return;
      const { openTabIds, activeTabId, setActiveTab } = useTabs.getState();
      if (openTabIds.length < 2) return;
      e.preventDefault();
      e.stopPropagation();
      const cur = openTabIds.indexOf(activeTabId ?? '');
      // cur === -1 (stale/no active tab): +1 lands on index 0, -1 on the last.
      const next = (cur + (e.shiftKey ? -1 : 1) + openTabIds.length) % openTabIds.length;
      setActiveTab(openTabIds[next]);
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);
}
