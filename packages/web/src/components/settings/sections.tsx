import { lazy, Suspense, useMemo, type ComponentType } from 'react';
import { usePluginRegistry, type PluginSettingsSection } from '../../plugins/registry';
import { pluginIcon } from '../../plugins/sdk';
import { PluginBoundary } from '../../plugins/PluginBoundary';
import { PaintBrush, Bell, Microphone, Robot, Gauge, PlugsConnected, Key, Wrench, DeviceMobile, HardDrives, Info, UserCircle, PuzzlePiece, GraduationCap } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { Spinner } from '../common/Spinner';
import { can, type Feature } from '../../lib/profile';
import { hostCopy } from '../../lib/hostCopy';

// The sections' code is not in the first load (engineering program 2026-11-09, W2-E): this list
// (labels and icons, used by the navigation, the phone's list and the command palette) is, and the
// components come as ONE chunk (allSections.ts) when a section is first drawn. One chunk, so that
// a move from section to section needs no second request.
type SectionProps = { onDone?: () => void };
const sectionFallback = (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 160, width: '100%' }}>
    <Spinner size={20} />
  </div>
);
function lazySection(name: keyof typeof import('./allSections')): ComponentType<SectionProps> {
  const Impl = lazy(() => import('./allSections').then((m) => ({ default: m[name] as ComponentType<SectionProps> })));
  const Section = (props: SectionProps) => <Suspense fallback={sectionFallback}><Impl {...props} /></Suspense>;
  Section.displayName = name;
  return Section;
}
/** Start the fetch of the sections' code before a section is drawn (e.g. when Settings opens). */
export function preloadSettingsSections(): void { void import('./allSections').catch(() => {}); }
const AppearanceSection = lazySection('AppearanceSection');
const NotificationsSection = lazySection('NotificationsSection');
const DictationSection = lazySection('DictationSection');
const AgentsSection = lazySection('AgentsSection');
const AccountsSection = lazySection('AccountsSection');
const UsageLimitsSection = lazySection('UsageLimitsSection');
const IntegrationsSection = lazySection('IntegrationsSection');
const SecretsSection = lazySection('SecretsSection');
const ToolsSection = lazySection('ToolsSection');
const AccessSection = lazySection('AccessSection');
const ServersSection = lazySection('ServersSection');
const PluginsSection = lazySection('PluginsSection');
const SkillsSection = lazySection('SkillsSection');
const AboutSection = lazySection('AboutSection');

/**
 * The settings sections, declared once and rendered by both shells:
 *   - desktop  → SettingsView, a full page with a grouped vertical section nav
 *   - mobile   → MobileSettings, a grouped drill-down list (Settings ▸ section)
 *
 * Adding a section here surfaces it in both places. Sections sit in three groups, in the
 * order people open them: YOU (how Dispatch looks and talks to you), AGENTS (what your
 * agents run with), THIS MAC (the machine and who can reach it). `blurb` is one short line
 * (at most 32 characters, so it never wraps on a phone) under the label in the phone's list.
 */
export type SettingsSectionKey =
  | 'appearance' | 'notifications' | 'dictation'
  | 'agents' | 'accounts' | 'usage' | 'integrations' | 'secrets' | 'tools'
  | 'devices' | 'servers' | 'plugins' | 'skills' | 'about';

export type SettingsGroup = 'YOU' | 'AGENTS' | 'THIS MAC' | 'PLUGINS';
export const SETTINGS_GROUPS: readonly SettingsGroup[] = ['YOU', 'AGENTS', 'THIS MAC'];

export type SettingsSection = {
  /** A built-in key, or `plugin:<id>:<section>` for a plugin's section. */
  key: string;
  group: SettingsGroup;
  label: string;
  blurb: string;
  icon: Icon;
  /** `onDone` dismisses the surrounding chrome; only About uses it (the setup wizard). */
  Component: ComponentType<{ onDone?: () => void }>;
  /** The profile feature that shows this section (lib/profile.ts). A plugin's section: 'settings.plugins'. */
  feature?: Feature;
};

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { key: 'appearance', group: 'YOU', label: 'Appearance', blurb: 'Theme, accent, text, density', icon: PaintBrush, Component: AppearanceSection, feature: 'settings.appearance' },
  { key: 'notifications', group: 'YOU', label: 'Notifications', blurb: 'Push alerts and which ones', icon: Bell, Component: NotificationsSection, feature: 'settings.notifications' },
  { key: 'dictation', group: 'YOU', label: 'Dictation', blurb: 'Speech-to-text provider', icon: Microphone, Component: DictationSection, feature: 'settings.dictation' },
  { key: 'agents', group: 'AGENTS', label: 'Agents', blurb: 'Defaults for each harness', icon: Robot, Component: AgentsSection, feature: 'settings.agents' },
  { key: 'accounts', group: 'AGENTS', label: 'Accounts', blurb: 'Signed-in accounts', icon: UserCircle, Component: AccountsSection, feature: 'accounts' },
  { key: 'usage', group: 'AGENTS', label: 'Usage limits', blurb: 'Warnings and current use', icon: Gauge, Component: UsageLimitsSection, feature: 'settings.usage' },
  { key: 'integrations', group: 'AGENTS', label: 'Integrations', blurb: 'MCP tools for your agents', icon: PlugsConnected, Component: IntegrationsSection, feature: 'settings.integrations' },
  { key: 'secrets', group: 'AGENTS', label: 'Secrets', blurb: 'Doppler environment variables', icon: Key, Component: SecretsSection, feature: 'settings.secrets' },
  { key: 'tools', group: 'AGENTS', label: 'Tools', blurb: 'CLI tools and sign-ins', icon: Wrench, Component: ToolsSection, feature: 'settings.tools' },
  { key: 'devices', group: 'THIS MAC', label: 'Devices & access', blurb: 'Sign in a phone, your devices', icon: DeviceMobile, Component: AccessSection, feature: 'settings.devices' },
  { key: 'servers', group: 'THIS MAC', label: 'Servers', blurb: 'Other Dispatch machines', icon: HardDrives, Component: ServersSection, feature: 'settings.servers' },
  { key: 'plugins', group: 'THIS MAC', label: 'Plugins', blurb: 'Plugins and marketplaces', icon: PuzzlePiece, Component: PluginsSection, feature: 'settings.plugins' },
  { key: 'skills', group: 'THIS MAC', label: 'Skills', blurb: 'Texts every thread gets', icon: GraduationCap, Component: SkillsSection, feature: 'settings.skills' },
  { key: 'about', group: 'THIS MAC', label: 'About & updates', blurb: 'Version, updates, setup', icon: Info, Component: AboutSection, feature: 'settings.about' },
];

/** Keys from before the reorganization, still found in old history entries and links. */
const LEGACY_KEYS: Record<string, SettingsSectionKey> = { general: 'appearance', access: 'devices', harnesses: 'agents', transcription: 'dictation' };

/** May this person see the section (lib/profile.ts)? A section with no feature is always shown. */
const shown = (s: SettingsSection) => !s.feature || can(s.feature);

/** The built-in sections this person sees: all of them in the developer profile. */
export function visibleSettingsSections(): SettingsSection[] {
  return SETTINGS_SECTIONS.filter(shown);
}

/** A section by key, or undefined when it does not exist or the profile hides it (a link then lands on the first section). */
export function settingsSection(key: string): SettingsSection | undefined {
  const k = LEGACY_KEYS[key] ?? key;
  const s = SETTINGS_SECTIONS.find((x) => x.key === k) ?? pluginSections(usePluginRegistry.getState().settings).find((x) => x.key === k);
  return s && shown(s) ? s : undefined;
}

/** The heading of a group. "THIS MAC" names the machine, so a hosted workspace says WORKSPACE (lib/hostCopy.ts). */
export function settingsGroupLabel(g: SettingsGroup): string {
  return g === 'THIS MAC' ? hostCopy('settings.group.machine', g) : g;
}

// Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md, section 2.3): a plugin's sections join
// the list under a PLUGINS group, each inside a boundary so a throwing section stays a card in Settings.
const pluginSectionCache = new WeakMap<PluginSettingsSection, SettingsSection>();
function pluginSections(list: PluginSettingsSection[]): SettingsSection[] {
  return list.map((p) => {
    let s = pluginSectionCache.get(p);
    if (!s) {
      const C = p.Component;
      const Wrapped = (props: { onDone?: () => void }) => <PluginBoundary plugin={p.plugin}><C {...props} /></PluginBoundary>;
      s = { key: p.key, group: 'PLUGINS', label: p.label, blurb: p.blurb ?? '', icon: pluginIcon(p.icon), Component: Wrapped, feature: 'settings.plugins' };
      pluginSectionCache.set(p, s);
    }
    return s;
  });
}

/** Every section: the built-in ones, then the plugins'. */
export function useAllSettingsSections(): SettingsSection[] {
  const plugins = usePluginRegistry((s) => s.settings);
  return useMemo(() => [...SETTINGS_SECTIONS, ...pluginSections(plugins)].filter(shown), [plugins]);
}

/** The groups that have sections: PLUGINS only once a plugin added one; a group the profile empties is left out. */
export function useSettingsGroups(): readonly SettingsGroup[] {
  const sections = useAllSettingsSections();
  return useMemo(() => {
    const all: readonly SettingsGroup[] = sections.some((s) => s.group === 'PLUGINS') ? [...SETTINGS_GROUPS, 'PLUGINS'] : SETTINGS_GROUPS;
    return all.filter((g) => sections.some((s) => s.group === g));
  }, [sections]);
}
