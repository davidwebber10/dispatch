import { useMemo, type ComponentType } from 'react';
import { usePluginRegistry, type PluginSettingsSection } from '../../plugins/registry';
import { pluginIcon } from '../../plugins/sdk';
import { PluginBoundary } from '../../plugins/PluginBoundary';
import { PaintBrush, Bell, Microphone, Robot, Gauge, PlugsConnected, Key, Wrench, DeviceMobile, HardDrives, Info, UserCircle } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { AppearanceSection } from './AppearanceSection';
import { NotificationsSection } from './NotificationsSection';
import { DictationSection } from './DictationSection';
import { AgentsSection } from './AgentsSection';
import { AccountsSection } from './AccountsSection';
import { UsageLimitsSection } from './UsageLimitsSection';
import { IntegrationsSection } from './IntegrationsSection';
import { SecretsSection } from './SecretsSection';
import { ToolsSection } from './ToolsSection';
import { AccessSection } from './AccessSection';
import { ServersSection } from './ServersSection';
import { AboutSection } from './AboutSection';

/**
 * The settings sections, declared once and rendered by both shells:
 *   - desktop  → SettingsView, a full page with a grouped vertical section nav
 *   - mobile   → MobileSettings, a grouped drill-down list (Settings ▸ section)
 *
 * Adding a section here surfaces it in both places. Sections sit in three groups, in the
 * order people open them: YOU (how Dispatch looks and talks to you), AGENTS (what your
 * agents run with), THIS MAC (the machine and who can reach it). `blurb` is the subtitle
 * under the label on mobile and beside the title in the desktop content header.
 */
export type SettingsSectionKey =
  | 'appearance' | 'notifications' | 'dictation'
  | 'agents' | 'accounts' | 'usage' | 'integrations' | 'secrets' | 'tools'
  | 'devices' | 'servers' | 'about';

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
  { key: 'appearance', group: 'YOU', label: 'Appearance', blurb: 'Accent, text sizes, density, layout', icon: PaintBrush, Component: AppearanceSection },
  { key: 'notifications', group: 'YOU', label: 'Notifications', blurb: 'Push on this device, which alerts, devices', icon: Bell, Component: NotificationsSection },
  { key: 'dictation', group: 'YOU', label: 'Dictation', blurb: 'Speech-to-text provider and key', icon: Microphone, Component: DictationSection },
  { key: 'agents', group: 'AGENTS', label: 'Agents', blurb: 'Defaults per harness, Control Plane, working words', icon: Robot, Component: AgentsSection },
  { key: 'accounts', group: 'AGENTS', label: 'Accounts', blurb: 'Signed-in accounts per harness, the default for new threads', icon: UserCircle, Component: AccountsSection },
  { key: 'usage', group: 'AGENTS', label: 'Usage limits', blurb: 'Warning level, paused banner, current figures', icon: Gauge, Component: UsageLimitsSection },
  { key: 'integrations', group: 'AGENTS', label: 'Integrations', blurb: 'MCP integrations your agents can use', icon: PlugsConnected, Component: IntegrationsSection },
  { key: 'secrets', group: 'AGENTS', label: 'Secrets', blurb: 'Doppler environment variables', icon: Key, Component: SecretsSection },
  { key: 'tools', group: 'AGENTS', label: 'Tools', blurb: 'CLI tools installed and signed in', icon: Wrench, Component: ToolsSection },
  { key: 'devices', group: 'THIS MAC', label: 'Devices & access', blurb: 'Sign in a phone, signed-in devices', icon: DeviceMobile, Component: AccessSection },
  { key: 'servers', group: 'THIS MAC', label: 'Servers', blurb: 'Other Dispatch machines', icon: HardDrives, Component: ServersSection },
  { key: 'about', group: 'THIS MAC', label: 'About & updates', blurb: 'Version, updates, setup, usage stats', icon: Info, Component: AboutSection },
];

/** Keys from before the reorganisation, still found in old history entries and links. */
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
