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
 * One release: version and date as the title, a single line of what changed, and the full
 * note only if you ask for it.
 *
 * The panel used to render every note in full, which meant scrolling an essay — headings,
 * code blocks, several paragraphs — to answer "what is in this update". Worse, a note's own
 * `## What was wrong` heading rendered at almost the same weight as the release headline
 * above it, so there was no hierarchy to scan. Every note already opens with a one-line
 * summary in its H1; that line IS the answer, so it is all that shows by default.
 */
function ReleaseEntry({ entry, first }: { entry: ReleaseNote; first: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const { headline, body } = splitNoteHeadline(entry.notes);
  const date = formatDate(entry.publishedAt);

  return (
    <section style={{ marginTop: first ? 0 : 14, paddingTop: first ? 0 : 12, borderTop: first ? 'none' : '1px solid #2C2C32' }}>
      {/* Title row: the version leads, the date is metadata beside it. */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ font: '600 13px var(--font-mono)', color: 'var(--color-accent)', letterSpacing: '-.01em' }}>{entry.version}</span>
        {date && <span style={{ font: '400 10.5px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{date}</span>}
      </div>

      {/* The one line that answers "what changed". */}
      {headline
        ? <div style={{ marginTop: 3, fontSize: 13, lineHeight: 1.45, color: 'var(--color-text-secondary)' }}>{headline}</div>
        : !body && <div style={{ marginTop: 3, fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>No notes for this release.</div>}

      {body && (
        <>
          <button type="button" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}
            style={{ ...toggle, marginTop: 4, padding: '3px 0', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
            <CaretRight size={10} weight="bold" style={{ transform: showAll ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />
            {showAll ? 'Hide detail' : 'Full notes'}
          </button>
          {showAll && <div style={{ marginTop: 2 }}><Markdown source={body} /></div>}
        </>
      )}
    </section>
  );
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
          {entries.map((entry, i) => (
            <ReleaseEntry key={entry.version || i} entry={entry} first={i === 0} />
          ))}
        </div>
      )}
    </div>
  );
}
