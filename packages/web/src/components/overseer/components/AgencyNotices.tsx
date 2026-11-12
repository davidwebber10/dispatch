// Overseer — the daemon's agency notices in the coordinator transcript (moved here from
// Stream.tsx when the Control Plane started rendering through the thread view's
// renderTimeline; overseer/timeline.tsx's userRow hook swaps them in for the "You" bubble).
//
// Ledger chips (pinned card spec 2026-10-08, Unit 9) are drawn inside both the pill and the card.

import { useState } from 'react';
import { Bell, ChatTeardropText, CheckCircle, Clock, PauseCircle, WarningCircle } from '@phosphor-icons/react';
import { useOverseer } from '../store';
import { LedgerChipText } from './LedgerChips';
import type { LedgerChips } from '../../../lib/ledgerRefs';
import { fontVar } from '../../../lib/fontSize';

// ---- Agency system notice (centered, muted) ---------------------------------
// The coordinator conversation receives injected LIFECYCLE notices about its own agents
// (posted by service.notifyStarterOfAgent → they land as USER-role stream items, so
// without this they'd render as a right-aligned "You" bubble, as if the human typed the raw
// coordinator-facing blob — agentId + "call answer_agent(…) / re-spawn with new guidance …
// Do not silently ignore this" instructions and all).
//
// We recognise these notice shapes by their leading emoji + phrase and re-present each as a
// muted system line, dropping the internal orchestration text (agentId, the coordinator
// instructions). Detection is frontend-only: the injected text is unchanged upstream
// (packages/core/src/sessions/service.ts), we only reshape its PRESENTATION here.
// Source templates:
//   ✅ Your agent "<label>" […] just finished a turn.…             (noteAgentCompletion)
//   ⏸️ Your agent "<label>" […] is BLOCKED, waiting on you …       (noteAgentNeedsHelp)
//   🔔 Your agent "<label>" […] is PAUSED waiting on you …         (formatAgentQuestion)
//   ⚠️ The user just <stopped|interrupted> your agent "<label>" …  (noteAgentLifecycle)
//   🕒 Interim recap due: 2 new items wait on the user, …          (sessions/interim-recap.ts)
// The five agent notices end with a daemon "Batch:" block; detection keys on the start only.
//
// 💬 (noteUserMessageToAgent — "the user just sent your agent … a message directly") is denser
// (it carries the user's actual message, which is worth keeping legible) so it gets its own
// card below — DirectMessageNoticeMsg — instead of collapsing to the one-line pill.

type NoticeIconCmp = typeof CheckCircle; // all phosphor icons share one component type

export interface AgencyNotice {
  icon: NoticeIconCmp;      // phosphor icon for this notice type
  color: string;            // per-type accent (icon tint only; the text stays muted)
  summary: string;          // concise, user-facing one-liner (internal blob dropped)
  agentId: string | null;   // parsed terminal id → tap the pill to open that agent's lightbox
}

// The agent LABEL is always the FIRST double-quoted run in the notice; a later
// `(mission "…")` is the SECOND, so the first match is the name. '' when absent.
function firstQuoted(text: string): string {
  const m = text.match(/"([^"]+)"/);
  return m ? m[1] : '';
}

// The agent's terminal id is embedded in the raw (pre-reshape) notice so the pill can deep-link
// to that agent's lightbox. Two shapes across the templates (packages/core/src/sessions/
// service.ts): `[agentId <id>]` (finished ✅ / stopped ⚠️) and `agentId: "<id>"` (paused 🔔's
// answer_agent call). Try the bracket form first, then the quoted form. null ⇒ leave the pill
// non-clickable.
function parseAgentId(text: string): string | null {
  const bracket = text.match(/\[agentId\s+([^\]\s]+)\]/);
  if (bracket) return bracket[1];
  const quoted = text.match(/agentId:\s*"([^"]+)"/);
  if (quoted) return quoted[1];
  return null;
}

// Detect an injected agency notice on a USER message (returns null for a real user turn).
// Guarded on emoji AT START *and* a signature phrase so a human message that merely opens
// with the same emoji isn't mistaken for a system notice.
export function detectAgencyNotice(text: string): AgencyNotice | null {
  const t = text.trimStart();
  const name = firstQuoted(t);
  const agentId = parseAgentId(t);
  // ✅ finished a turn
  if (t.startsWith('✅') && /your agent|finished a turn/i.test(t)) {
    return { icon: CheckCircle, color: 'var(--acc)', summary: name ? `Agent "${name}" finished` : 'Agent finished a turn', agentId };
  }
  // ⏸️ blocked — the agent stopped its turn to ask (match the base ⏸ codepoint; the source
  // carries a trailing VS16). Before this branch it fell through to a raw "You" bubble.
  if (t.startsWith('⏸') && /your agent|is BLOCKED/i.test(t)) {
    return { icon: PauseCircle, color: 'var(--yellow)', summary: name ? `Agent "${name}" is blocked, waiting on you` : 'Agent is blocked, waiting on you', agentId };
  }
  // 🕒 interim recap due — no agent subject (its only quoted word is "interim")
  if (t.startsWith('🕒') && /interim recap due/i.test(t)) {
    return { icon: Clock, color: 'var(--acc)', summary: 'Interim recap due', agentId: null };
  }
  // 🔔 paused / waiting on an answer
  if (t.startsWith('🔔') && /your agent|is PAUSED/i.test(t)) {
    return { icon: Bell, color: 'var(--yellow)', summary: name ? `Agent "${name}" needs an answer` : 'Agent needs an answer', agentId };
  }
  // ⚠️ user stopped / interrupted an agent (match the base ⚠ codepoint — the source carries a
  // trailing VS16). Echo the actual verb the notice used.
  if (t.startsWith('⚠') && /your agent|just (stopped|interrupted)/i.test(t)) {
    const verb = /just interrupted/i.test(t) ? 'interrupted' : 'stopped';
    return { icon: WarningCircle, color: 'var(--red)', summary: name ? `You ${verb} agent "${name}"` : `You ${verb} an agent`, agentId };
  }
  return null;
}

export function AgencyNoticeMsg({ notice, ledger }: { notice: AgencyNotice; ledger?: LedgerChips }) {
  const NoticeIcon = notice.icon;
  const drillInto = useOverseer((s) => s.drillInto);
  const [hover, setHover] = useState(false);
  // A notice that carries an agentId deep-links into that agent's lightbox (same action the
  // rail chips use). Notices without a parseable id stay inert — no cursor / hover affordance.
  const clickable = !!notice.agentId;
  return (
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      <span
        onClick={clickable ? () => drillInto(notice.agentId!) : undefined}
        onMouseEnter={clickable ? () => setHover(true) : undefined}
        onMouseLeave={clickable ? () => setHover(false) : undefined}
        role={clickable ? 'button' : undefined}
        title={clickable ? 'Open this agent' : undefined}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          padding: '4px 12px',
          borderRadius: 'var(--radius-2xl)',
          background: clickable && hover ? 'var(--hover)' : 'var(--elev)',
          border: `1px solid ${clickable && hover ? 'var(--accLine)' : 'var(--border)'}`,
          fontSize: fontVar(11.5),
          color: 'var(--ts)',
          maxWidth: '86%',
          cursor: clickable ? 'pointer' : 'default',
          transition: 'background .12s, border-color .12s',
        }}
      >
        <NoticeIcon size={13} weight="fill" color={notice.color} style={{ flex: 'none' }} />
        <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><LedgerChipText text={notice.summary} ledger={ledger} /></span>
      </span>
    </div>
  );
}

// ---- Direct-message notice (centered, card) ---------------------------------
// 💬 noteUserMessageToAgent (packages/core/src/sessions/service.ts): the user bypassed the
// coordinator and messaged one of its agents directly. Unlike the pill notices above, the
// user's actual words are the point of this notice — collapsing them to a one-liner would
// defeat it — so this gets a small card: agent name/mission as the label (same de-emphasized
// mission-line convention AgentCard uses), the quoted message as the focal content, and the
// "go check on it" instruction shrunk to muted guidance instead of one run-on sentence.

export interface DirectMessageNotice {
  name: string;             // agent label — '"agent"' fallback mirrors detectAgencyNotice's summaries
  mission: string | null;
  quote: string;            // the user's message, as sent to the agent
  agentId: string | null;   // → drillInto; never shown raw (parity with AgencyNoticeMsg/AgentCard)
}

function parseMission(text: string): string | null {
  const m = text.match(/\(mission "([^"]+)"\)/);
  return m ? m[1] : null;
}

// The quoted message sits between the template's two fixed markers — anchoring on those
// (rather than balancing quote characters) keeps this correct even if the user's own message
// contains a `"`. Non-greedy so a message that itself contains the closing marker text can't
// swallow past its own end.
function parseDirectMessageQuote(text: string): string {
  const m = text.match(/not through you: "([\s\S]*?)"\. This may change/);
  return m ? m[1] : '';
}

export function detectDirectMessageNotice(text: string): DirectMessageNotice | null {
  const t = text.trimStart();
  if (!(t.startsWith('💬') && /sent your agent/i.test(t))) return null;
  return {
    name: firstQuoted(t) || 'agent',
    mission: parseMission(t),
    quote: parseDirectMessageQuote(t) || t.replace(/^💬\s*/, ''),
    agentId: parseAgentId(t),
  };
}

export function DirectMessageNoticeMsg({ notice, ledger }: { notice: DirectMessageNotice; ledger?: LedgerChips }) {
  const drillInto = useOverseer((s) => s.drillInto);
  const [hover, setHover] = useState(false);
  const clickable = !!notice.agentId;
  return (
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      <div
        onClick={clickable ? () => drillInto(notice.agentId!) : undefined}
        onMouseEnter={clickable ? () => setHover(true) : undefined}
        onMouseLeave={clickable ? () => setHover(false) : undefined}
        role={clickable ? 'button' : undefined}
        title={clickable ? 'Open this agent' : undefined}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: '9px 13px',
          borderRadius: 'var(--radius-lg)',
          background: clickable && hover ? 'var(--hover)' : 'var(--elev)',
          border: `1px solid ${clickable && hover ? 'var(--accLine)' : 'var(--border)'}`,
          maxWidth: '86%',
          cursor: clickable ? 'pointer' : 'default',
          transition: 'background .12s, border-color .12s',
        }}
      >
        {/* label row — icon + agent name (prominent), mission de-emphasized alongside it */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <ChatTeardropText size={14} weight="fill" color="var(--acc)" style={{ flex: 'none' }} />
          <span style={{ fontSize: fontVar(12), fontWeight: 600, color: 'var(--tp)', whiteSpace: 'nowrap' }}>
            Direct message to "{notice.name}"
          </span>
          {notice.mission && (
            <span
              style={{
                fontSize: fontVar(10.5),
                color: 'var(--ts)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              · {notice.mission}
            </span>
          )}
        </div>
        {/* focal content — the user's own words, quoted */}
        <div
          style={{
            fontSize: fontVar(12.5),
            lineHeight: 1.5,
            color: 'var(--tp)',
            paddingLeft: 20,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          “<LedgerChipText text={notice.quote} ledger={ledger} />”
        </div>
        {/* de-emphasized guidance — was the run-on sentence's tail, now a muted footnote */}
        <div style={{ fontSize: fontVar(10.5), color: 'var(--tt)', paddingLeft: 20 }}>
          This may change what you asked it to do — read how it responds and adjust.
        </div>
      </div>
    </div>
  );
}
