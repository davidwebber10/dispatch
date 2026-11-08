import { ArrowUpRight, BookOpen, Bug, ClockCounterClockwise, type Icon } from '@phosphor-icons/react';
import { useSetup } from '../../stores/setup';
import { UpdatesSection } from './UpdatesSection';
import { TelemetrySetting } from './TelemetrySetting';
import { SettingsPage, SettingsGroup, SettingsRow, IconTile } from './ui';

const REPO = 'https://github.com/davidwebber10/dispatch';

/**
 * Settings → About & updates: the running version and updates, the setup wizard, the anonymous
 * usage stats switch, and links out. `onDone` dismisses the surrounding chrome so the wizard is not
 * buried: on desktop it leaves the settings page; on a phone settings is a screen, so it is omitted.
 *
 * 2026-11-07 (docs/design/settings-layout.md): four groups — Dispatch (version, updates, notes),
 * Setup, Usage stats, Links.
 */
export function AboutSection({ onDone }: { onDone?: () => void }) {
  const openSetup = useSetup((s) => s.open);
  return (
    <SettingsPage>
      <UpdatesSection />

      <SettingsGroup title="Setup">
        <SettingsRow label="Re-run setup wizard" ariaLabel="Re-run setup wizard" hint="Agent CLIs, phone access and secrets, step by step."
          onClick={() => { openSetup(); onDone?.(); }} />
      </SettingsGroup>

      {/* Renders nothing until the daemon answers. */}
      <TelemetrySetting />

      <SettingsGroup title="Links">
        <LinkRow icon={ClockCounterClockwise} label="Release history" hint="Every version and its notes." href={`${REPO}/releases`} />
        <LinkRow icon={BookOpen} label="Documentation" hint="Setup, providers, remote access." href={`${REPO}#readme`} />
        <LinkRow icon={Bug} label="Report a problem" hint="Open an issue on GitHub." href={`${REPO}/issues/new`} />
      </SettingsGroup>
    </SettingsPage>
  );
}

/**
 * A row that opens a page in a new tab: the row's look (icon tile, label, hint) as a real link, with
 * an out-arrow where a sub-page row has its chevron. Local; a candidate for settings/ui.
 */
function LinkRow({ icon, label, hint, href }: { icon: Icon; label: string; hint?: string; href: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" aria-label={`${label} (opens in a new tab)`}
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 12px', minWidth: 0, color: 'inherit', textDecoration: 'none' }}>
      <IconTile icon={icon} size={32} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13.5, color: 'var(--color-text-primary)' }}>{label}</span>
        {hint && <span style={{ display: 'block', marginTop: 2, fontSize: 12, lineHeight: 1.4, color: 'var(--color-text-tertiary)' }}>{hint}</span>}
      </span>
      <ArrowUpRight aria-hidden size={16} color="var(--color-text-tertiary)" style={{ flexShrink: 0 }} />
    </a>
  );
}
