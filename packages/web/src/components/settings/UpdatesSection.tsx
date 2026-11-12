import { useEffect, useState } from 'react';
import type { ReleaseNote } from '../../api/types';
import { useUpdate } from '../../stores/update';
import { useApplyUpdate } from '../update/useApplyUpdate';
import { STEP_LABEL } from '../update/UpdateProgress';
import { Markdown } from '../Markdown';
import { splitNoteHeadline } from '../../lib/releaseNotes';
import { SettingsGroup, SettingsRow, Sheet, StatusMark } from './ui';
import { Button } from '../ui';
import { fontVar } from '../../lib/fontSize';

/**
 * Settings → About & updates → the "Dispatch" group: the always-reachable update surface (the
 * modal can be dismissed — or missed entirely on the PWA before it was a modal). Shows the running
 * version, checks GitHub on demand, applies + auto-refreshes, and opens the release notes.
 *
 * 2026-11-07 (docs/design/settings-layout.md): one group of rows — Version (a value), the update row
 * (one button on the right, its result as the hint), and a release-notes row whose hint is the
 * one-line headline; the full notes open in a sheet.
 */
export function UpdatesSection() {
  const available = useUpdate((s) => s.available);
  const currentVersion = useUpdate((s) => s.currentVersion);
  const notes = useUpdate((s) => s.notes);
  const currentNotes = useUpdate((s) => s.currentNotes);
  const { apply, applying, failReason, inProgress, hosted } = useApplyUpdate();
  const progressStep = useUpdate((st) => (st.progressUnreachable ? 'restart' : st.progress?.step ?? null));
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [checkError, setCheckError] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  // Opening Updates refreshes what it shows (2026-11-05): the stored release can be one behind when
  // a newer one shipped since the daemon's last check. Quiet — the daemon reuses a check from the
  // last minute, and a failure leaves what is shown.
  useEffect(() => { void useUpdate.getState().check().catch(() => {}); }, []);

  async function check() {
    setChecking(true); setChecked(false); setCheckError(false);
    try { await useUpdate.getState().check(); setChecked(true); }
    catch { setCheckError(true); }
    setChecking(false);
  }

  // Pending update → what it contains (every version being installed, newest first).
  // Up to date → what the running version brought.
  const pending = notes.length > 0;
  const entries: ReleaseNote[] = pending
    ? notes
    : currentNotes
      ? [{ version: currentVersion ? `v${currentVersion.replace(/^v/, '')}` : '', url: '', publishedAt: '', notes: currentNotes }]
      : [];
  const notesLabel = pending
    ? (entries.length > 1 ? `Release notes (${entries.length} versions)` : 'Release notes')
    : `What's new in ${entries[0]?.version || 'this version'}`;
  const headline = entries[0] ? splitNoteHeadline(entries[0].notes).headline : null;

  const updateRow = inProgress ? (
    <SettingsRow label="Updating" hint={`${progressStep ? `${STEP_LABEL[progressStep]}. ` : ''}This page reloads by itself when the update is done.`}
      control={<StatusMark tone="accent">In progress</StatusMark>} />
  ) : available ? (
    <SettingsRow label={<span style={{ color: 'var(--color-accent)', fontWeight: 600 }}>{available.version} is available</span>}
      hint="Dispatch restarts, and this page reloads by itself."
      control={(
        <Button variant="primary" size="sm" onClick={() => void apply()} disabled={applying} style={applying ? { opacity: 0.7 } : undefined}>
          {applying ? 'Updating…' : 'Update now'}
        </Button>
      )} />
  ) : (
    <SettingsRow label="Check for updates"
      hint={checkError
        ? <span style={{ color: 'var(--color-status-red)' }}>Couldn't reach the server.</span>
        : checked ? "You're up to date." : 'Looks for a newer release on GitHub.'}
      control={<Button onClick={() => void check()} disabled={checking} variant="ghost" size="sm" style={checking ? { opacity: 0.6 } : undefined}>{checking ? 'Checking…' : 'Check now'}</Button>} />
  );

  return (
    <>
    <SettingsGroup title="Dispatch">
      <SettingsRow label="Version" value={currentVersion ? `v${currentVersion}` : 'Unknown'} />
      {updateRow}
      {failReason && (
        <SettingsRow label="Couldn't update automatically" hint={(
          <>
            {failReason}{' '}
            {/* `dispatch update` is dead advice on a hosted workspace: there is no
                checkout to pull and no shell to run it in. The honest fallback is the
                person who can rebuild the fleet image. */}
            {hosted
              ? 'Your workspace updates when it is rebuilt onto a newer image — ask an administrator if this keeps failing.'
              : <>Run <code style={{ font: `400 ${fontVar(11)} var(--font-mono)` }}>dispatch update</code> manually instead.</>}
          </>
        )} />
      )}
      {entries.length > 0 && (
        <SettingsRow label={notesLabel} ariaLabel={notesLabel} hint={headline ?? undefined} onClick={() => setNotesOpen(true)} />
      )}
    </SettingsGroup>
    {/* Outside the card: a closed sheet would still take a row slot (a stray hairline). */}
    {entries.length > 0 && (
      <Sheet open={notesOpen} onClose={() => setNotesOpen(false)} title={notesLabel}>
        <div style={{ maxHeight: 'min(70vh, 560px)', overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {entries.map((e, i) => <NoteEntry key={e.version || i} entry={e} first={i === 0} />)}
        </div>
      </Sheet>
    )}
    </>
  );
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** One release in the notes sheet: version and date, the headline, then the whole note. */
function NoteEntry({ entry, first }: { entry: ReleaseNote; first: boolean }) {
  const { headline, body } = splitNoteHeadline(entry.notes);
  const date = formatDate(entry.publishedAt);
  return (
    <section style={{ marginTop: first ? 0 : 16, paddingTop: first ? 0 : 14, borderTop: first ? 'none' : '1px solid var(--color-border)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ font: `600 ${fontVar(13)} var(--font-mono)`, color: 'var(--color-accent)' }}>{entry.version}</span>
        {date && <span style={{ fontSize: fontVar(11.5), color: 'var(--color-text-tertiary)' }}>{date}</span>}
        {entry.author && <span style={{ fontSize: fontVar(11.5), color: 'var(--color-text-tertiary)' }}>by {entry.author}</span>}
      </div>
      {headline && <div style={{ marginTop: 4, fontSize: fontVar(14), fontWeight: 600, lineHeight: 1.4, color: 'var(--color-text-primary)' }}>{headline}</div>}
      {body ? <div style={{ marginTop: 6 }}><Markdown source={body} /></div>
        : !headline && <div style={{ marginTop: 4, fontSize: fontVar(12.5), color: 'var(--color-text-tertiary)' }}>No notes for this release.</div>}
    </section>
  );
}
