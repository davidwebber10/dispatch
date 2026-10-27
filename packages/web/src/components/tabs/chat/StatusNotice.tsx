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

import type { ReactNode } from 'react';
import { parseReportStatus, reportStatusKey } from './reportStatus';
import { useDismissedNotices } from '../../../stores/dismissedNotices';

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

/** `renderText` lets a surface draw the summary and the ask its own way (the Control Plane adds ledger chips).
 *  `onDismiss`, when given, puts an × in the header row so the reader can close the card
 *  (2026-10-27: the cards are tall and a long thread stacks many of them; once read they are
 *  clutter). The card itself is stateless — the caller decides what "closed" means; see
 *  <DismissableStatusNotice> for the persisted default every surface uses. */
export function StatusNotice({ input, renderText, onDismiss }: { input?: string; renderText?: (text: string) => ReactNode; onDismiss?: () => void }) {
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
        {onDismiss && (
          // 28px square hit area for a thumb, but margin pulls it back so the header row
          // keeps its height; padding:0 because the UA button padding + global border-box
          // otherwise squeezes the SVG to a sliver (same fix as the +/sort icons, v2.8.10).
          <button
            type="button"
            aria-label="Hide this status"
            title="Hide"
            data-testid="status-notice-dismiss"
            onClick={onDismiss}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, margin: '-8px -9px -8px 0', padding: 0,
              border: 'none', background: 'transparent', borderRadius: 6,
              color: 'var(--color-text-tertiary)', cursor: 'pointer', flexShrink: 0,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
            </svg>
          </button>
        )}
      </div>
      {showSummary && (
        <div style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>{renderText ? renderText(rs.summary!) : rs.summary}</div>
      )}
      {primary && (
        <div style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--color-text-primary)', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>{renderText ? renderText(primary) : primary}</div>
      )}
    </div>
  );
}

/**
 * The <StatusNotice> every surface actually renders: the same card, with an × that hides
 * it and remembers the choice (stores/dismissedNotices.ts, localStorage). `scope` is the
 * thread or coordinator the card belongs to, so closing "Done" in one thread never hides an
 * identically-worded "Done" in another. Renders nothing once dismissed. Used from the plain
 * render functions (renderTimeline / renderStream) that cannot call hooks themselves.
 */
export function DismissableStatusNotice({ scope, input, renderText }: { scope?: string; input?: string; renderText?: (text: string) => ReactNode }) {
  const key = reportStatusKey(input);
  const sc = scope ?? 'global';
  const dismissed = useDismissedNotices((s) => key != null && s.keys.includes(`${sc}:${key}`));
  const dismiss = useDismissedNotices((s) => s.dismiss);
  if (dismissed) return null;
  return <StatusNotice input={input} renderText={renderText} onDismiss={key ? () => dismiss(sc, key) : undefined} />;
}
