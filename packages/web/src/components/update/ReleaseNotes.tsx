import { useState } from 'react';
import { CaretRight } from '@phosphor-icons/react';
import type { ReleaseNote } from '../../api/types';
import { Markdown } from '../Markdown';
import { splitNoteHeadline } from '../../lib/releaseNotes';

interface Props {
  /** Notes for the pending update — every version between here and the newest, newest first. */
  notes: ReleaseNote[];
  /** The note for the version running now. Shown only when `notes` is empty. */
  currentNote?: string | null;
  currentVersion?: string | null;
  /** Fires on expand/collapse — the update modal widens while the panel is open. */
  onToggle?: (open: boolean) => void;
}

const toggle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, width: '100%',
  padding: '6px 2px', background: 'none', border: 'none',
  color: 'var(--color-text-secondary)', font: '500 12px var(--font-sans, inherit)', cursor: 'pointer',
};

const panel: React.CSSProperties = {
  marginTop: 4, textAlign: 'left',
  maxHeight: 'min(45vh, 320px)', overflowY: 'auto', overscrollBehavior: 'contain',
  background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 10,
  padding: '10px 12px',
};

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * The expandable "Release notes" disclosure, shared by the update modal and
 * Settings → UPDATES so both read from one implementation.
 *
 * When an update is pending it lists every version being installed, newest first — an
 * install that skipped two versions sees all three. When nothing is pending it falls
 * back to the note for the version already running, which the daemon reads off disk.
 */
export function ReleaseNotes({ notes, currentNote, currentVersion, onToggle }: Props) {
  const [open, setOpen] = useState(false);

  const pending = notes.length > 0;
  const entries: ReleaseNote[] = pending
    ? notes
    : currentNote
      ? [{ version: currentVersion ? `v${currentVersion.replace(/^v/, '')}` : '', url: '', publishedAt: '', notes: currentNote }]
      : [];
  if (entries.length === 0) return null;

  const label = pending
    ? (entries.length > 1 ? `Release notes (${entries.length} versions)` : 'Release notes')
    : `What's new in ${entries[0].version || 'this version'}`;

  function flip() {
    const next = !open;
    setOpen(next);
    onToggle?.(next);
  }

  return (
    <div className="release-notes" style={{ marginTop: 12 }}>
      <button type="button" onClick={flip} aria-expanded={open} style={toggle}>
        <CaretRight size={12} weight="bold" style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />
        {label}
      </button>
      {open && (
        <div style={panel}>
          {entries.map((entry, i) => {
            const { headline, body } = splitNoteHeadline(entry.notes);
            const date = formatDate(entry.publishedAt);
            return (
              <section key={entry.version || i} style={{ marginTop: i === 0 ? 0 : 18, paddingTop: i === 0 ? 0 : 14, borderTop: i === 0 ? 'none' : '1px solid #2C2C32' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ font: '600 12px var(--font-mono)', color: 'var(--color-accent)' }}>{entry.version}</span>
                  {date && <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{date}</span>}
                </div>
                {headline && (
                  <div style={{ marginTop: 2, fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)' }}>{headline}</div>
                )}
                {body
                  ? <Markdown source={body} />
                  : !headline && <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>No notes for this release.</div>}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
