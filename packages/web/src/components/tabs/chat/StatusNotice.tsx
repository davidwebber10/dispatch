// Renders a report_status tool call as VISIBLE content in thread view, instead of the collapsed
// "Wrench" block every other tool falls through to. This is the fix for the model burying its
// findings/question inside report_status while its reply says only "waiting on your feedback":
// the tool still captures the status for the board, but the human reading the thread now sees it.
//
// Card language (2026-08-16 pretty-chat redesign, docs/design/2026-08-16-pretty-chat-restyle.md):
// a tinted card with a header row — 6px state dot, letterspaced mono label, right-aligned mono
// meta — over the summary/ask text. State accents:
//
//   - needs_you — CORAL (the design's #F37165 family), the most prominent: findings + the ask
//                 verbatim, meta "paused". Coral, not amber: it must match the NEEDS YOU ask-card
//                 so "waiting on you" reads as ONE state everywhere in the thread.
//   - blocked   — blue: same layout, blocker verbatim. Blue so "waiting on another agent/timer"
//                 doesn't read as "waiting on you".
//   - done      — green tinted card, label DONE.
//   - unknown   — neutral card labeled with the raw state, so a new state never silently borrows
//                 another state's meaning.

import { parseReportStatus } from './reportStatus';

interface StateStyle {
  label: string;
  dot: string;
  accent: string;      // label color
  border: string;
  background: string;
  meta?: string;
}

const STATE_STYLES: Record<'done' | 'needs_you' | 'blocked', StateStyle> = {
  needs_you: {
    label: 'NEEDS YOU',
    dot: '#F37165',
    accent: '#f0a79f',
    border: '#7d4640',
    background: 'rgba(243,113,101,.06)',
    meta: 'paused',
  },
  blocked: {
    label: 'BLOCKED',
    dot: '#5CA7E8',
    accent: '#8fc1ea',
    border: 'rgba(92,167,232,.45)',
    background: 'rgba(92,167,232,.07)',
    meta: 'waiting',
  },
  done: {
    label: 'DONE',
    dot: '#3ECF6A',
    accent: '#8bc994',
    border: 'rgba(62,207,106,.3)',
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
        label: (rs.state ?? 'STATUS').toUpperCase(),
        dot: 'var(--color-text-tertiary)',
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

  return (
    <div
      data-testid="status-notice"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 9,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: style.border,
        background: style.background,
        borderRadius: 6,
        padding: '12px 13px',
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: style.dot, flexShrink: 0 }} />
        <span style={{ font: '500 9.5px var(--font-mono)', letterSpacing: '1.3px', color: style.accent }}>{style.label}</span>
        <span style={{ flex: 1 }} />
        {style.meta && <span style={{ font: '400 10.5px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{style.meta}</span>}
      </div>
      {showSummary && (
        <div style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>{rs.summary}</div>
      )}
      {primary && (
        <div style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--color-text-primary)', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>{primary}</div>
      )}
    </div>
  );
}
