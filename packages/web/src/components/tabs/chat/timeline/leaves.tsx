import { memo, useState, type ReactNode } from 'react';
import { Sparkle, Brain, CaretRight, CheckCircle, WarningCircle, ArrowBendDownRight, ArrowClockwise } from '@phosphor-icons/react';
import type { ConvItem } from '../../../../api/types';
import { friendlyModelName } from '../../../../lib/modelName';
import { ClaudeLogin } from '../../../endless/ClaudeLogin';
import { useDispatchName } from '../../../../stores/settings';
import { InsightText } from '../../../InsightText';
import type { LedgerChips } from '../../../../lib/ledgerRefs';
import { useThreadDocs } from '../../../threadDocs';
import { Spinner } from '../../../common/Spinner';
import { ToolCall, editDiffStat } from '../../ToolCall';
import { useToolGroupExpanded, useThoughtExpanded, uiKeyOf } from '../../../../hooks/useToolUIState';
import { stableId } from './stableId';

// The leaf rows are memoized (W1-F): renderTimeline builds new elements on every walk, and a walk
// happens for each streamed delta. A row whose props are equal (the same text, the same item) is
// then skipped, so a delta renders the block that grew and not the whole transcript.

/**
 * A system-injected background-task completion (see lib/taskNotification.ts). Styled to
 * read as machine bookkeeping, not speech: muted, small, flush-left, at the same indent as
 * a tool row — which is what it is, structurally, the tail of a backgrounded tool call.
 * Only the CLI's own <summary> line is shown; the surrounding XML (task-id, tool-use-id,
 * output-file) is bookkeeping the reader has no use for.
 */
export const TaskNotice = memo(function TaskNotice({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 6px', minWidth: 0 }}>
      <CheckCircle size={13} weight="bold" color="var(--color-text-tertiary)" style={{ flexShrink: 0 }} />
      <span style={{ minWidth: 0, fontSize: 11.5, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={text}>
        {text}
      </span>
    </div>
  );
});

/** One assistant turn: a flush-left flex-column holding all its blocks. */
export function AssistantTurn({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {children}
    </div>
  );
}

/**
 * A consecutive run of machinery (tool calls/groups/orphan results) fenced by hairlines —
 * the redesign renders a turn's tool activity as one strip of terminal-ish rows between
 * prose paragraphs. Inner rows separate with a fainter hairline; the strip has no side
 * borders or background, so it stays quieter than a card.
 */
export function MachineryBlock({ nodes }: { nodes: React.ReactNode[] }) {
  return (
    // Full-bleed (David's call): the -20px margins cancel MessageScroller.Content's side
    // padding so row hover backgrounds run edge to edge; each row re-adds the 20px as its
    // OWN padding, which keeps the caret exactly on the text rail.
    <div style={{ display: 'flex', flexDirection: 'column', margin: '0 -20px', borderTop: '1px solid var(--color-hover)', borderBottom: '1px solid var(--color-hover)' }}>
      {nodes.map((n, i) => (
        <div key={i} style={{ minWidth: 0, borderTop: i > 0 ? '1px solid color-mix(in srgb, var(--color-hover) 55%, transparent)' : 'none' }}>{n}</div>
      ))}
    </div>
  );
}

/** One run member paired with its already-resolved result (by toolId, or en bloc by
 * position — see renderTimeline's `pairs` construction), so ToolGroup never has to
 * re-derive pairing. */
export type ToolPair = { tool: ConvItem; result?: ConvItem };

/**
 * A run of consecutive same-tool calls, collapsed to one row. Six Reads in a turn
 * would otherwise be six separate rows that bury the assistant's prose.
 *
 * Expansion is TRI-STATE via `useToolGroupExpanded` — `undefined` (untouched) means
 * "auto": expanded while any member is running, collapsed once the whole run settles.
 * The instant the reader manually toggles it (`true`/`false`), that choice wins
 * permanently thereafter, including across the running→settled transition — a manual
 * COLLAPSE while a member is still running must stick, not get forced back open by
 * `running`, and a manual EXPAND must survive the run settling. A plain boolean (as
 * `open || running` used to compute it) can't represent "the reader hasn't touched
 * this yet" as distinct from "the reader chose collapsed."
 *
 * Expansion state is keyed off the FIRST member's id, which is immutable as a run
 * grows — the group's React key is anchored to its LAST item by renderTimeline, for
 * the scroll-preservation reasons documented there. Uses `toolId ?? uuid` (not the
 * reverse): `useStructuredChat` upgrades every content block of an assistant message to
 * that message's single `uuid` once the whole-message event lands, so several distinct
 * groups within one settled parallel-tool turn would otherwise collide on the same
 * `group:<uuid>` key and share one expansion toggle. `toolId` is unique per tool_use.
 */
export function ToolGroup({ pairs, onViewFile }: { pairs: ToolPair[]; onViewFile: (p: string) => void }) {
  const firstId = uiKeyOf(pairs[0].tool);
  const running = pairs.some((p) => !p.result);
  const [manualOpen, setManualOpen] = useToolGroupExpanded(firstId ? `group:${firstId}` : undefined, undefined);
  const expanded = manualOpen === undefined ? running : manualOpen;
  const toolName = pairs[0].tool.toolName ?? 'tool';
  const lines = pairs.reduce((n, p) => n + (p.result?.text?.split('\n').length ?? 0), 0);
  // Aggregate edit stat across the run (the redesign's `+33 −9`): only shown when EVERY
  // member yields a stat — a mixed/partial sum would misstate the run.
  const stats = pairs.map((p) => editDiffStat(p.tool.toolName, p.tool.toolInput));
  const diff = stats.length > 0 && stats.every((s): s is { add: number; del: number } => s !== null)
    ? stats.reduce((a, s) => ({ add: a.add + s.add, del: a.del + s.del }), { add: 0, del: 0 })
    : null;

  if (expanded) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <GroupHeader toolName={toolName} count={pairs.length} lines={lines} diff={diff} running={running} open onClick={() => setManualOpen(false)} />
        {/* Members flush-left with the header (no indent — David's call): the caret column
            on each row already provides the visual hierarchy. */}
        <div style={{ display: 'flex', flexDirection: 'column', paddingBottom: 4 }}>
          {pairs.map(({ tool: t, result }) => (
            <ToolCall key={stableId(t)} tool={t} result={result} onViewFile={onViewFile} />
          ))}
        </div>
      </div>
    );
  }
  return <GroupHeader toolName={toolName} count={pairs.length} lines={lines} diff={diff} running={running} open={false} onClick={() => setManualOpen(true)} />;
}

function GroupHeader({ toolName, count, lines, diff, running, open, onClick }: { toolName: string; count: number; lines: number; diff: { add: number; del: number } | null; running: boolean; open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onClick}
      style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '0 20px', height: 30, display: 'flex', gap: 10, alignItems: 'center' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-hover)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
    >
      <span style={{ width: 14, flexShrink: 0, display: 'flex', justifyContent: 'flex-start' }}>
        <CaretRight size={10} weight="bold" style={{ color: 'var(--color-text-tertiary)', transition: 'transform .12s ease', transform: open ? 'rotate(90deg)' : 'none' }} />
      </span>
      <span style={{ flexShrink: 0, font: '400 11.5px var(--font-mono)', color: 'var(--color-text-secondary)' }}>{toolName}</span>
      <span style={{ flexShrink: 0, font: '400 11.5px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>×{count}</span>
      <span style={{ flex: 1, minWidth: 0 }} />
      {diff && <span style={{ flexShrink: 0, font: '400 11px var(--font-mono)', color: 'color-mix(in srgb, var(--color-status-green) 60%, var(--color-text-primary))' }}>+{diff.add} −{diff.del}</span>}
      {running
        ? <span className="chat-shimmer" style={{ flexShrink: 0, fontSize: 11 }}>running…</span>
        : !diff && <span style={{ flexShrink: 0, font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{lines} line{lines !== 1 ? 's' : ''}</span>}
    </button>
  );
}

// Centered in the visible chat area (55vh ≈ the space above the composer on a phone),
// replacing the EmptyState while the socket is down — see the render-site comment.
export function ReconnectingState() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, height: '55vh', color: 'var(--color-text-secondary)', fontSize: 13.5 }}>
      <Spinner size={22} />
      <span>Reconnecting…</span>
    </div>
  );
}

export function EmptyState({ model }: { model?: string }) {
  return (
    <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13.5, textAlign: 'center', padding: '48px 0' }}>
      <Sparkle size={28} weight="duotone" color="var(--color-accent)" style={{ marginBottom: 10 }} />
      <div style={{ color: 'var(--color-text-secondary)' }}>Send a message to start the conversation.</div>
      {model && <div style={{ marginTop: 6, fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{friendlyModelName(model) ?? model}</div>}
    </div>
  );
}

// A 'user'-role turn the coordinator sent on the human's behalf (spawn_agent / message_agent)
// still needs its own right-aligned slot in the timeline (it's structurally a user turn), but
// reading it as "sent by the human" would be misleading — so it gets a small "via {Dispatch
// name}" label (same ArrowBendDownRight "relayed" icon the coordinator's own Stream uses for
// injected notices) and a muted/bordered bubble instead of the bright human-accent one.
// `source === 'user'` or undefined (untagged/legacy) renders exactly like before.
// `relayName` overrides the Dispatch name: a thread Chat started reads "via Chat".
// `sendState` (W2-I): the bubble was added at Send, before the daemon's echo. 'sending' dims it;
// 'failed' adds a "Not sent" line and, when the surface can send again, a Retry button.
export const UserBubble = memo(function UserBubble({ text, source, grouped = false, relayName, renderText, sendState, onRetry }: { text: string; source?: 'user' | 'coordinator'; grouped?: boolean; relayName?: string; renderText?: (text: string) => ReactNode; sendState?: 'sending' | 'failed'; onRetry?: () => void }) {
  const dispatchName = useDispatchName();
  const viaCoordinator = source === 'coordinator';
  return (
    <div style={{ alignSelf: 'flex-end', maxWidth: '82%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, padding: grouped ? '0 0 4px' : '8px 0 4px' }}>
      {/* Turn meta (redesign): a small mono label above the bubble instead of an anonymous
          blob — YOU for the human, the relay attribution for a coordinator-sent turn. A
          `grouped` bubble (back-to-back sends with no agent response between) omits the
          label: one YOU covers the whole run. No timestamp yet: ConvItems carry no
          wall-clock time, and a fabricated one would lie on every replayed/paged item. */}
      {grouped ? null : viaCoordinator ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, font: '500 9.5px var(--font-mono)', letterSpacing: '1.3px', color: 'var(--color-accent)' }}>
          <ArrowBendDownRight size={11} weight="bold" />
          VIA {(relayName ?? dispatchName).toUpperCase()}
        </div>
      ) : (
        <span style={{ font: '500 9.5px var(--font-mono)', letterSpacing: '1.3px', color: 'var(--color-accent)' }}>YOU</span>
      )}
      <div
        data-testid="user-bubble"
        data-send-state={sendState}
        aria-busy={sendState === 'sending' || undefined}
        style={{
          ...(sendState ? { opacity: sendState === 'sending' ? 0.72 : 0.6 } : {}),
          background: viaCoordinator ? 'var(--color-elevated)' : 'var(--color-accent)',
          border: viaCoordinator ? '1px solid var(--color-border)' : 'none',
          color: viaCoordinator ? 'var(--color-text-primary)' : 'var(--color-on-accent)',
          borderRadius: 'var(--radius-md)',
          padding: '12px 15px',
          font: '500 15.5px var(--font-sans)',
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {renderText ? renderText(text) : text}
      </div>
      {sendState === 'failed' && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, font: '500 12px var(--font-sans)', color: 'var(--color-status-red)' }}>
          <WarningCircle size={14} weight="fill" />
          <span>Not sent</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 28, padding: '0 10px', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', font: '500 12px var(--font-sans)', cursor: 'pointer' }}
            >
              <ArrowClockwise size={13} weight="bold" />
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
});

// Assistant prose flows through the SHARED <InsightText>; the chat surface uses the redesign's
// left-railed clamped insight blocks (variant="rail") rather than the coordinator's tinted
// callouts. The wrapper sets the redesign's reading size — md-view inherits it.
// `ledger` (the Control Plane) draws known ledger numbers as chips.
export const AssistantText = memo(function AssistantText({ text, ledger }: { text: string; ledger?: LedgerChips }) {
  const docs = useThreadDocs();
  if (!text) return null;
  return (
    <div style={{ fontSize: 14.5, lineHeight: 1.75, minWidth: 0 }}>
      <InsightText source={text} scheme="global" variant="rail" docs={docs} ledger={ledger} />
    </div>
  );
});

// Collapsed, the row IS the preview: brain icon + the thought's first words in one dim italic
// line (the icon alone says "thinking" — pairing the word with a preview read as two competing
// texts). A Grok turn interleaves many thinking blocks between tool calls, so a column of
// identical "Thinking" rows is unscannable, but so is a column of full-width ragged prose —
// hence the single ellipsized line, width-capped so it doesn't stretch edge to edge. The word
// "Thinking" returns as the header only while the row is open.
/** `id`: the block's stable key (hooks/useToolUIState `uiKeyOf`). The open state lives under it, so
 *  it survives the remount that every appended block and the uuid upgrade cause (2026-11-06). */
export const Thinking = memo(function Thinking({ id, text }: { id?: string; text: string }) {
  const [open, setOpen] = useThoughtExpanded(id, false);
  if (!text.trim()) return null;
  // One flat line: collapse whitespace, drop backtick fences — markdown isn't rendered here,
  // so literal backticks are just clutter in a preview.
  const preview = text.trim().replace(/\s+/g, ' ').replace(/`/g, '');
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, maxWidth: '100%', minWidth: 0, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', font: 'italic 400 12.5px var(--font-sans)', padding: 0 }}
      >
        <CaretRight size={11} weight="bold" style={{ flexShrink: 0, transition: 'transform .12s', transform: open ? 'rotate(90deg)' : 'none' }} />
        <Brain size={13} weight="duotone" style={{ flexShrink: 0 }} />
        {open ? (
          <span style={{ flexShrink: 0, color: 'var(--color-text-secondary)' }}>Thinking</span>
        ) : (
          <span style={{ minWidth: 0, maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {preview || 'Thinking'}
          </span>
        )}
      </button>
      {open && (
        <div style={{ marginTop: 5, paddingLeft: 12, borderLeft: '2px solid var(--color-border)', color: 'var(--color-text-secondary)', font: 'italic 400 13px var(--font-sans)', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {text}
        </div>
      )}
    </div>
  );
});

/** Under a turn that failed on the Claude login: log the daemon in, then the user sends again. */
function ResultLogin() {
  const [done, setDone] = useState(false);
  if (done) return <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>Logged in. Send your message again.</div>;
  return <ClaudeLogin onDone={() => setDone(true)} />;
}

export const ResultFooter = memo(function ResultFooter({ item, login = false }: { item: ConvItem; login?: boolean }) {
  const parts: string[] = [];
  if (typeof item.costUsd === 'number') parts.push(`$${item.costUsd.toFixed(item.costUsd < 0.01 ? 4 : 2)}`);
  const tok = (item.tokensIn ?? 0) + (item.tokensOut ?? 0);
  if (tok > 0) parts.push(`${tok.toLocaleString()} tok`);
  if (item.durationMs) parts.push(`${(item.durationMs / 1000).toFixed(1)}s`);
  if (item.turns) parts.push(`${item.turns} turn${item.turns !== 1 ? 's' : ''}`);
  if (item.isError) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-status-red)', font: '400 12px var(--font-sans)' }}>
          <WarningCircle size={14} weight="fill" /> {item.text || 'Turn ended with an error'}
          {parts.length > 0 && <span style={{ opacity: 0.7 }}> · {parts.join(' · ')}</span>}
        </div>
        {login && <ResultLogin />}
      </div>
    );
  }
  if (parts.length === 0) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-secondary)', font: '400 11.5px var(--font-mono)' }}>
      <CheckCircle size={13} weight="fill" color="var(--color-accent)" /> {parts.join(' · ')}
    </div>
  );
});
