import type { ComponentType } from 'react';
import { Gear, PlugsConnected, Key, Wrench, Microphone } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { GeneralSection } from './GeneralSection';
import { SecretsSection } from './SecretsSection';
import { IntegrationsSection } from './IntegrationsSection';
import { ToolsSection } from './ToolsSection';
import { TranscriptionSection } from './TranscriptionSection';

/**
 * The settings sections, declared once and rendered by both shells:
 *   - desktop  → SettingsModal, as a horizontal tab strip
 *   - mobile   → MobileSettings, as a drill-down list (Settings ▸ section)
 *
 * Adding a section here surfaces it in both places. `blurb` is mobile-only — the
 * desktop tab strip has no room for a subtitle.
 */
export type SettingsSectionKey = 'general' | 'integrations' | 'secrets' | 'tools' | 'transcription';

export type SettingsSection = {
  key: SettingsSectionKey;
  label: string;
  blurb: string;
  icon: Icon;
  /** `onDone` dismisses the surrounding chrome; only General uses it (setup wizard). */
  Component: ComponentType<{ onDone?: () => void }>;
};

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { key: 'general', label: 'General', blurb: 'Coordinator, connection, appearance, updates', icon: Gear, Component: GeneralSection },
  { key: 'integrations', label: 'Integrations', blurb: 'Connected services', icon: PlugsConnected, Component: IntegrationsSection },
  { key: 'secrets', label: 'Secrets', blurb: 'Doppler environment variables', icon: Key, Component: SecretsSection },
  { key: 'tools', label: 'Tools', blurb: 'Agent tool permissions', icon: Wrench, Component: ToolsSection },
  { key: 'transcription', label: 'Transcription', blurb: 'Dictation and speech-to-text', icon: Microphone, Component: TranscriptionSection },
];

export function settingsSection(key: SettingsSectionKey): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find((s) => s.key === key);
}
