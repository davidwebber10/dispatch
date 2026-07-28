// Renders a report_status tool call as VISIBLE content in thread view, instead of the collapsed
// "Wrench" block every other tool falls through to. This is the fix for the model burying its
// findings/question inside report_status while its reply says only "waiting on your feedback":
// the tool still captures the status for the board, but the human reading the thread now sees it.
//
//   - needs_you / blocked  — a prominent amber card: the label, the summary (its findings), and
//                            the ask/blocker verbatim. This is the "important response" that was
//                            being buried.
//   - done / other         — a muted one-line "✓ <summary>". report_status fires every turn, so
//                            a finished turn stays low-key (its result belongs in the reply); the
//                            line just guarantees the summary is never fully hidden.
//
// Uses app-global `--color-*` tokens plus the board's amber status accent (#E8B04B), matching how
// Needs Help reads on the board so "this needs you" looks the same in both surfaces.

import { CheckCircle } from '@phosphor-icons/react';
import { parseReportStatus } from './reportStatus';

const AMBER = '#E8B04B';

export function StatusNotice({ input }: { input?: string }) {
  const rs = parseReportStatus(input);
  if (!rs) return null;

  const isNeedsYou = rs.state === 'needs_you';
  const isBlocked = rs.state === 'blocked';

  // done / anything-not-actionable → a muted single line; nothing to show if there's no summary.
  if (!isNeedsYou && !isBlocked) {
    if (!rs.summary) return null;
    return (
      <div data-testid="status-notice" style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 6px', minWidth: 0 }}>
        <CheckCircle size={13} weight="bold" color="var(--color-text-tertiary)" style={{ flexShrink: 0 }} />
        <span
          style={{ minWidth: 0, fontSize: 11.5, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={rs.summary}
        >
          {rs.summary}
        </span>
      </div>
    );
  }

  const label = isNeedsYou ? 'Waiting on you' : 'Blocked';
  // The verbatim line: the question (needs_you) / blocker (blocked), falling back to the summary.
  const primary = isNeedsYou ? rs.ask ?? rs.summary : rs.blocker ?? rs.summary;
  // Show the summary as context above the primary line only when it's genuinely different text
  // (a needs_you turn often carries findings in `summary` and the question in `ask`).
  const showSummary = !!rs.summary && rs.summary !== primary;

  return (
    <div
      data-testid="status-notice"
      style={{
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'rgba(232,176,75,.5)',
        background: 'rgba(232,176,75,.07)',
        borderRadius: 'var(--radius-md)',
        padding: '8px 11px',
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4, color: AMBER, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span aria-hidden>⏸</span> {label}
      </div>
      {showSummary && (
        <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap' }}>{rs.summary}</div>
      )}
      {primary && (
        <div style={{ marginTop: 4, fontSize: 13, color: 'var(--color-text-primary)', fontStyle: 'italic', whiteSpace: 'pre-wrap' }}>{primary}</div>
      )}
    </div>
  );
}
