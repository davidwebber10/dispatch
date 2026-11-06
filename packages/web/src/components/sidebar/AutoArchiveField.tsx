import { Timer } from '@phosphor-icons/react';
import { Toggle } from '../settings/ui';
import { DEFAULT_AUTO_ARCHIVE_MS, toDuration, fromDuration, type DurationUnit } from '../../lib/autoArchive';

interface AutoArchiveFieldProps {
  enabled: boolean;
  ms: number;
  onChange: (enabled: boolean, ms: number) => void;
  /** Settings → Agents sits it flush inside an already-elevated card. */
  flush?: boolean;
}

const UNITS: DurationUnit[] = ['minutes', 'hours', 'days'];

/**
 * The auto-archive toggle + duration control, shared by the New Thread modal and
 * the context-menu editor. The stored value is always ms; the unit picker is
 * presentational (toDuration picks the unit that reads most naturally).
 */
export function AutoArchiveField({ enabled, ms, onChange, flush }: AutoArchiveFieldProps) {
  const { value, unit } = toDuration(ms || DEFAULT_AUTO_ARCHIVE_MS);

  const input: React.CSSProperties = {
    height: 32, width: 64, padding: '0 8px', background: 'var(--color-elevated)', border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', fontSize: 13, fontFamily: 'var(--font-mono)',
  };

  return (
    <div style={flush ? undefined : { marginTop: 14, padding: 12, background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Timer size={16} weight="fill" color="var(--color-text-tertiary)" />
        <span style={{ flex: 1, fontSize: 13, color: 'var(--color-text-primary)' }}>Auto-archive thread</span>
        {/* The app's one switch style (settings/ui Toggle), not a checkbox. */}
        <Toggle on={enabled} label="Auto-archive thread" onClick={() => onChange(!enabled, ms || DEFAULT_AUTO_ARCHIVE_MS)} />
      </div>

      {enabled && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Archive after</span>
          <input
            type="number"
            min={1}
            step={1}
            aria-label="Inactivity before archiving"
            value={value}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n > 0) onChange(true, fromDuration(n, unit));
            }}
            style={input}
          />
          <select
            aria-label="Inactivity unit"
            value={unit}
            onChange={(e) => onChange(true, fromDuration(value, e.target.value as DurationUnit))}
            style={{ ...input, width: 'auto' }}
          >
            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
          <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>of inactivity</span>
        </div>
      )}

      {enabled && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          Archived automatically once idle this long. It won&apos;t be archived while it&apos;s working, queued, or waiting on you.
        </div>
      )}
    </div>
  );
}
