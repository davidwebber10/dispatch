import { X } from '@phosphor-icons/react';
import type { Terminal } from '../../api/types';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useSettings, CLI_PRETTY_HINT_KEY } from '../../stores/settings';
import { useTransportSwitch } from '../layout/TransportToggle';
import { fontVar } from '../../lib/fontSize';

export { CLI_PRETTY_HINT_KEY };

/**
 * One-line nudge above a CLI-transport AI thread: long responses read best on the
 * Pretty (structured) transport. The CLI view can only show what survives the pty's
 * bounded byte replay — a width change rewraps it into noise, and a respawn reduces
 * history to the TUI's resume stub — so a finished turn's prose is routinely
 * unreadable there. The button performs the same switch as TransportToggle and is
 * gated the same way (a captured session id, no turn in flight).
 *
 * `reserveRight` keeps that many pixels free on the right (2026-10-12): on desktop the thread's
 * floating bell and CLI/Pretty switch sit over the hint's right end and hid both buttons.
 *
 * One dismissal covers every thread — the hint is a one-time education, not a nag. Since
 * 2026-10-27 the × and Settings → TERMINAL → "Pretty hint" are the same switch
 * (settings.showPrettyHint), so the hint can be hidden, or brought back, from Settings.
 */
export function CliPrettyHint({ tab, reserveRight }: { tab: Terminal; reserveRight?: number }) {
  const dismissed = !useSettings((s) => s.showPrettyHint);
  const isMobile = useIsMobile();
  // The shared switch (layout/TransportToggle): mid-turn it asks first, then stops the turn and switches.
  const { canSwitch, tip, request, confirmUi } = useTransportSwitch(tab.id, tab);

  if (dismissed) return null;

  // One line on a phone (2026-11-06): the full sentence wrapped to two under the header.
  const short = isMobile;
  const switchToPretty = () => request('pretty');

  return (
    <>
    {confirmUi}
    <div
      data-testid="cli-pretty-hint"
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '5px 12px', paddingRight: reserveRight || 12, flexShrink: 0,
        background: 'var(--color-elevated)', borderBottom: '1px solid var(--color-border-strong)',
        color: 'var(--color-text-secondary)', fontSize: fontVar(12), lineHeight: 1.4,
      }}
    >
      <span style={{ flex: 1, minWidth: 0, ...(short ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } : {}) }}
        title={short ? 'Long responses read best in Pretty — the CLI view can rewrap or drop replayed output.' : undefined}>
        {short ? 'Reads best in Pretty' : 'Long responses read best in Pretty — the CLI view can rewrap or drop replayed output.'}
      </span>
      <button
        type="button"
        disabled={!canSwitch}
        title={tip}
        onClick={switchToPretty}
        style={short ? {
          flexShrink: 0, height: 24, padding: '0 4px', border: 'none', background: 'transparent', color: 'var(--color-accent)',
          font: `500 ${fontVar(13)} var(--font-sans)`, cursor: canSwitch ? 'pointer' : 'not-allowed', opacity: canSwitch ? 1 : 0.5,
        } : {
          flexShrink: 0, height: 22, padding: '0 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border-strong)',
          background: 'var(--color-hover)', color: 'var(--color-text-primary)',
          font: `600 ${fontVar(11)} var(--font-mono, monospace)`, letterSpacing: '0.3px',
          cursor: canSwitch ? 'pointer' : 'not-allowed', opacity: canSwitch ? 1 : 0.5,
        }}
      >
        {short ? 'Switch' : 'Switch to Pretty'}
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        title="Don't show this again"
        onClick={() => useSettings.getState().setShowPrettyHint(false)}
        style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 20, height: 20, padding: 0, borderRadius: 'var(--radius-sm)', border: 'none',
          background: 'transparent', color: 'var(--color-text-tertiary)', cursor: 'pointer',
        }}
      >
        <X size={12} weight="bold" />
      </button>
    </div>
    </>
  );
}
