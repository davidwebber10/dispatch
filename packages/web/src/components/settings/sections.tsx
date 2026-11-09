import { lazy, Suspense, useMemo, type ComponentType } from 'react';
import { usePluginRegistry, type PluginSettingsSection } from '../../plugins/registry';
import { pluginIcon } from '../../plugins/sdk';
import { PluginBoundary } from '../../plugins/PluginBoundary';
import { PaintBrush, Bell, Microphone, Robot, Gauge, PlugsConnected, Key, Wrench, DeviceMobile, HardDrives, Info, UserCircle, PuzzlePiece, GraduationCap } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { Spinner } from '../common/Spinner';

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
};

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { key: 'appearance', group: 'YOU', label: 'Appearance', blurb: 'Theme, accent, text, density', icon: PaintBrush, Component: AppearanceSection },
  { key: 'notifications', group: 'YOU', label: 'Notifications', blurb: 'Push alerts and which ones', icon: Bell, Component: NotificationsSection },
  { key: 'dictation', group: 'YOU', label: 'Dictation', blurb: 'Speech-to-text provider', icon: Microphone, Component: DictationSection },
  { key: 'agents', group: 'AGENTS', label: 'Agents', blurb: 'Defaults for each harness', icon: Robot, Component: AgentsSection },
  { key: 'accounts', group: 'AGENTS', label: 'Accounts', blurb: 'Signed-in accounts', icon: UserCircle, Component: AccountsSection },
  { key: 'usage', group: 'AGENTS', label: 'Usage limits', blurb: 'Warnings and current use', icon: Gauge, Component: UsageLimitsSection },
  { key: 'integrations', group: 'AGENTS', label: 'Integrations', blurb: 'MCP tools for your agents', icon: PlugsConnected, Component: IntegrationsSection },
  { key: 'secrets', group: 'AGENTS', label: 'Secrets', blurb: 'Doppler environment variables', icon: Key, Component: SecretsSection },
  { key: 'tools', group: 'AGENTS', label: 'Tools', blurb: 'CLI tools and sign-ins', icon: Wrench, Component: ToolsSection },
  { key: 'devices', group: 'THIS MAC', label: 'Devices & access', blurb: 'Sign in a phone, your devices', icon: DeviceMobile, Component: AccessSection },
  { key: 'servers', group: 'THIS MAC', label: 'Servers', blurb: 'Other Dispatch machines', icon: HardDrives, Component: ServersSection },
  { key: 'plugins', group: 'THIS MAC', label: 'Plugins', blurb: 'Plugins and marketplaces', icon: PuzzlePiece, Component: PluginsSection },
  { key: 'skills', group: 'THIS MAC', label: 'Skills', blurb: 'Texts every thread gets', icon: GraduationCap, Component: SkillsSection },
  { key: 'about', group: 'THIS MAC', label: 'About & updates', blurb: 'Version, updates, setup', icon: Info, Component: AboutSection },
];

/** Keys from before the reorganization, still found in old history entries and links. */
const LEGACY_KEYS: Record<string, SettingsSectionKey> = { general: 'appearance', access: 'devices', harnesses: 'agents', transcription: 'dictation' };

export function settingsSection(key: string): SettingsSection | undefined {
  const k = LEGACY_KEYS[key] ?? key;
  return SETTINGS_SECTIONS.find((s) => s.key === k) ?? pluginSections(usePluginRegistry.getState().settings).find((s) => s.key === k);
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
      s = { key: p.key, group: 'PLUGINS', label: p.label, blurb: p.blurb ?? '', icon: pluginIcon(p.icon), Component: Wrapped };
      pluginSectionCache.set(p, s);
    }
    return s;
  });
}

/** Every section: the built-in ones, then the plugins'. */
export function useAllSettingsSections(): SettingsSection[] {
  const plugins = usePluginRegistry((s) => s.settings);
  return useMemo(() => [...SETTINGS_SECTIONS, ...pluginSections(plugins)], [plugins]);
}

/** The groups that have sections: PLUGINS only once a plugin added one. */
export function useSettingsGroups(): readonly SettingsGroup[] {
  const n = usePluginRegistry((s) => s.settings.length);
  return n > 0 ? [...SETTINGS_GROUPS, 'PLUGINS'] : SETTINGS_GROUPS;
}
