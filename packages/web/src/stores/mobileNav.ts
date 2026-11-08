import { create } from 'zustand';

/** The item page open on top of a settings section on the phone: an account, a harness, a plugin. */
export type SettingsSubPage = { section: string; id: string; title: string | null };

/**
 * The phone's Settings sub-pages (2026-11-07): one item's page on top of a section (a plugin, an
 * account, a harness, a skill, a device, an integration). On a phone the page is a screen of the
 * Settings tab, so its open state lives here and in a history entry, not inside the section:
 * MobileApp names it in the header, back / edge-swipe close it, and the Settings tab brings it back
 * after a visit to another tab. The entry is `{ nav: 1, settingsSection, subPage, subTitle, depth }`.
 * Sections reach this through useSubPage (components/settings/subPageNav.ts).
 */
export const useMobileNav = create<{ sub: SettingsSubPage | null; setSub(sub: SettingsSubPage | null): void }>((set) => ({
  sub: null,
  setSub: (sub) => set({ sub }),
}));

type Entry = { settingsSection?: string; subPage?: string; subTitle?: string; depth?: number } | null;

/** The sub-page a history entry names, or null. */
export function subPageOfState(state: unknown): SettingsSubPage | null {
  const s = state as Entry;
  return s?.settingsSection && s.subPage ? { section: s.settingsSection, id: s.subPage, title: s.subTitle ?? null } : null;
}

/** Opens an item's page on the phone: one history entry above its section, so back closes it. */
export function openSettingsSubPage(section: string, id: string, title?: string | null) {
  const depth = ((history.state as Entry)?.depth ?? 0) + 1;
  history.pushState({ nav: 1, settingsSection: section, subPage: id, ...(title ? { subTitle: title } : {}), depth }, '', location.pathname);
  useMobileNav.getState().setSub({ section, id, title: title ?? null });
}

/** Closes it again: the entry it pushed is popped (the popstate handlers clear the state too). */
export function closeSettingsSubPage() {
  if (!useMobileNav.getState().sub) return;
  useMobileNav.getState().setSub(null);
  if (subPageOfState(history.state)) history.back();
}

/** Renames the open page in the header (an account or a device renamed on its own page). */
export function retitleSettingsSubPage(title: string) {
  const sub = useMobileNav.getState().sub;
  if (!sub || sub.title === title) return;
  useMobileNav.getState().setSub({ ...sub, title });
  const here = subPageOfState(history.state);
  if (here && here.section === sub.section && here.id === sub.id) history.replaceState({ ...(history.state as object), subTitle: title }, '', location.pathname);
}
