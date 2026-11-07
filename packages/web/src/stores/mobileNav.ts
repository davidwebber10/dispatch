import { create } from 'zustand';

/**
 * The phone's Settings → Plugins page per plugin (2026-11-07). On a phone the page is a screen of
 * the Settings tab, so its open state lives here and in a history entry, not inside PluginsSection:
 * MobileApp names it in the header, back / edge-swipe close it, and the Settings tab brings it back
 * after a visit to another tab.
 */
export const useMobileNav = create<{ settingsPluginId: string | null; setSettingsPluginId(id: string | null): void }>((set) => ({
  settingsPluginId: null,
  setSettingsPluginId: (settingsPluginId) => set({ settingsPluginId }),
}));

/** Opens a plugin's page on the phone: one history entry above the Plugins section, so back closes it. */
export function openSettingsPluginPage(id: string) {
  const depth = ((history.state as { depth?: number } | null)?.depth ?? 0) + 1;
  history.pushState({ nav: 1, settingsSection: 'plugins', pluginDetail: id, depth }, '', location.pathname);
  useMobileNav.getState().setSettingsPluginId(id);
}

/** Closes it again: the entry it pushed is popped (MobileApp's popstate handler clears the state too). */
export function closeSettingsPluginPage() {
  if (!useMobileNav.getState().settingsPluginId) return;
  useMobileNav.getState().setSettingsPluginId(null);
  if ((history.state as { pluginDetail?: string } | null)?.pluginDetail) history.back();
}
