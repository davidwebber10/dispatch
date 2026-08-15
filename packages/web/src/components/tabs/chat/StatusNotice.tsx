// Renders a report_status tool call as VISIBLE content in thread view, instead of the collapsed
// "Wrench" block every other tool falls through to. This is the fix for the model burying its
// findings/question inside report_status while its reply says only "waiting on your feedback":
// the tool still captures the status for the board, but the human reading the thread now sees it.
//
// Every state renders as a card with the same shape — icon, uppercase label, summary — so a turn's
// ending is always obvious at a glance, with the accent color carrying the state:
//
//   - needs_you  — amber, the most prominent: label, the summary (its findings), and the ask
//                  verbatim. This is the "important response" that was being buried.
//   - blocked    — blue: same layout, with the blocker verbatim. Blue (not amber) so "waiting on
//                  another agent/timer" doesn't read as "waiting on you".
//   - done       — green: label + full summary (wrapped, not truncated). Lighter accent than
//                  needs_you, but a real card — the earlier one-line muted render was easy to miss.
//   - unknown    — neutral gray card labeled with the raw state, so a new state never silently
//                  borrows another state's meaning.
//
// Uses app-global `--color-*` tokens plus hard-coded accents: the board's amber (#E8B04B) for
// Needs Help and the overseer rail's green (--acc, #3ECF6A) for Done, so both states read the
// same across surfaces.

import { CheckCircle, HourglassMedium, PauseCircle, Info } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { parseReportStatus } from './reportStatus';

interface StateStyle {
  label: string;
  IconGlyph: Icon;
  accent: string;      // label + icon color
  border: string;
  background: string;
}

const STATE_STYLES: Record<'done' | 'needs_you' | 'blocked', StateStyle> = {
  needs_you: {
    label: 'Waiting on you',
    IconGlyph: PauseCircle,
    accent: '#E8B04B',
    border: 'rgba(232,176,75,.5)',
    background: 'rgba(232,176,75,.07)',
  },
  blocked: {
    label: 'Blocked',
    IconGlyph: HourglassMedium,
    accent: '#5CA7E8',
    border: 'rgba(92,167,232,.45)',
    background: 'rgba(92,167,232,.07)',
  },
  done: {
    label: 'Done',
    IconGlyph: CheckCircle,
    accent: '#3ECF6A',
    border: 'rgba(62,207,106,.35)',
    background: 'rgba(62,207,106,.06)',
  },
};

export function StatusNotice({ input }: { input?: string }) {
  const rs = parseReportStatus(input);
  if (!rs) return null;

  const known = rs.state === 'done' || rs.state === 'needs_you' || rs.state === 'blocked';
  const style: StateStyle = known
    ? STATE_STYLES[rs.state as 'done' | 'needs_you' | 'blocked']
    : {
        label: rs.state ?? 'Status',
        IconGlyph: Info,
        accent: 'var(--color-text-secondary)',
        border: 'var(--color-border)',
        background: 'transparent',
      };

  const isNeedsYou = rs.state === 'needs_you';
  const isBlocked = rs.state === 'blocked';

  // The verbatim line: the question (needs_you) / blocker (blocked), falling back to the summary.
  const primary = isNeedsYou ? rs.ask ?? rs.summary : isBlocked ? rs.blocker ?? rs.summary : undefined;
  // Show the summary as context above the primary line only when it's genuinely different text
  // (a needs_you turn often carries findings in `summary` and the question in `ask`).
  const showSummary = !!rs.summary && rs.summary !== primary;

  // Nothing to say at all (e.g. a bare `{state:"done"}`) → no card.
  if (!showSummary && !primary) return null;

  const { IconGlyph } = style;

  return (
    <div
      data-testid="status-notice"
      style={{
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: style.border,
        background: style.background,
        borderRadius: 'var(--radius-md)',
        padding: '8px 11px',
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4, color: style.accent, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
        <IconGlyph size={14} weight="fill" color={style.accent} style={{ flexShrink: 0 }} aria-hidden />
        {style.label}
      </div>
      {showSummary && (
        <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>{rs.summary}</div>
      )}
      {primary && (
        <div style={{ marginTop: 4, fontSize: 13, color: 'var(--color-text-primary)', fontStyle: 'italic', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>{primary}</div>
      )}
    </div>
  );
}
