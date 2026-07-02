// Overseer — ConversationStream (spec §6 "Conversation stream", §5 StreamMessage, §7, §8).
//
// Scrollable list of rv.stream, built on shadcn's MessageScroller chat primitive (the
// same one the agent ChatView uses). Renders four message variants:
//   isOverseer → left-aligned Dispatch turn (acc name + time header, then markdown body)
//   isUser     → right-aligned bubble (elev background, border, clipped top-right corner)
//   isImage    → left-aligned Dispatch turn whose body is a <ChatImage>
//   isNote     → centered accent pill (arrow-bend-down-right icon + text)
//
// Consecutive Dispatch turns (overseer + image) are grouped chat-app style: the "Dispatch"
// name+time header shows ONCE at the top of each run, not above every bubble.
//
// Scroll behaviour comes from the primitive, NOT a hand-rolled state machine:
//   • opens at the newest message (defaultScrollPosition="end")
//   • FOLLOWS a streaming reply — the primitive watches the viewport's CONTENT HEIGHT, so it
//     keeps pace as the last message's text grows (a count-based follow can't see this, since
//     streaming adds bytes without adding a message)
//   • a Scroll-to-Bottom button appears when the reader scrolls up, and they aren't yanked down
//   • StickToEndOnLoad re-sticks through the post-open backfill burst, re-arming per thread
//
// No prop drilling — reads the store directly.
// Desktop: flex:1 scroll (in the left conversation column). Mobile: fills the Stream tab.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MessageScroller, useMessageScroller, useMessageScrollerScrollable } from '@shadcn/react/message-scroller';
import { Bell, CaretDoubleDown, ChatTeardropText, CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { Icon } from '../atoms';
import { AgentCard } from './AgentCard';
import { ChatImage } from '../../ChatImage';
import { InsightText } from '../../InsightText';
import { WorkingIndicator } from '../../WorkingIndicator';
import { Spinner } from '../../common/Spinner';
import { AskQuestionCard, AnsweredQuestionCard } from '../../tabs/chat/AskQuestionCard';
import { useOverseer, useRenderVals } from '../store';
import { useBootstrapOlderPages } from '../../../hooks/useBootstrapOlderPages';
import type { StreamMessage } from '../types';

// `.md-view`'s CSS consumes the GLOBAL `--color-*` tokens (defined on :root), which
// cascade into `.overseer-root` unchanged — that's why markdown renders correctly here
// with no overseer-specific CSS. The overseer's own `--tp`/`--acc`/`--elev` aliases hold
// identical values, but `.md-view` does NOT read them, so consolidating/renaming the
// overseer token set would not affect markdown rendering (don't assume it does).

// ---- Dispatch header (time only) --------------------------------------------
// Shown once at the top of a run of consecutive Dispatch turns. Subsequent turns in the
// same run omit it (chat-app grouping) but keep the body left-aligned at the same x. No name
// label here — every turn in this stream is the coordinator's own, so labeling the speaker
// would be redundant (contrast the agent ChatView's UserBubble, which DOES need a "via
// {name}" badge since that stream mixes the human's turns with coordinator-relayed ones).

function DispatchHeader({ time }: { time: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--tt)' }}>{time}</span>
    </div>
  );
}

// ---- Overseer message -------------------------------------------------------
// Body prose renders through the SHARED <InsightText> (packages/web/src/components/
// InsightText.tsx), so any ★ Insight blocks become tinted callouts here EXACTLY as they do
// in the agent ChatView — the parsing/callout logic lives in one place, not per surface.

function OverseerMsg({ msg, showHeader }: { msg: StreamMessage; showHeader: boolean }) {
  if (!msg.text) return null; // parity with the agent AssistantText — no empty body
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
      {/* content column — fills the pane (no 64ch cap); side padding lives on Content */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
        {showHeader && <DispatchHeader time={msg.time} />}
        {/* body — prose + ★ Insight callouts, scoped to the overseer token set */}
        <InsightText source={msg.text} scheme="scoped" />
      </div>
    </div>
  );
}

// ---- Image message ----------------------------------------------------------
// Left-aligned on the coordinator's side (parity with OverseerMsg): a picture the
// coordinator surfaced — an agent/tool-emitted image, or one posted via `post_image`.
// The body is the shared <ChatImage>; src/alt are already resolved (data-URI or byte
// route) upstream in convItemsToStream, so this stays a dumb passthrough.

function ImageMsg({ msg, showHeader }: { msg: StreamMessage; showHeader: boolean }) {
  if (!msg.imageUrl) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
        {/* header — matches OverseerMsg so an image reads as a Dispatch turn (grouped) */}
        {showHeader && <DispatchHeader time={msg.time} />}
        {/* body — ChatImage caps its own height; left to fill the pane like prose */}
        <div style={{ minWidth: 0 }}>
          <ChatImage src={msg.imageUrl} alt={msg.imageAlt} />
        </div>
      </div>
    </div>
  );
}

// ---- User image message -----------------------------------------------------
// A picture the HUMAN attached on their own turn — right-aligned under a "You" header,
// mirroring UserMsg's alignment so an attachment reads as the user's message (not a
// Dispatch turn). src/alt are already resolved upstream in convItemsToStream.

function UserImageMsg({ msg }: { msg: StreamMessage }) {
  if (!msg.imageUrl) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ maxWidth: '72%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        {/* time + "You" header — right-aligned, parity with UserMsg */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--tt)' }}>{msg.time}</span>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ts)' }}>You</span>
        </div>
        {/* body — ChatImage caps its own height */}
        <div style={{ minWidth: 0, maxWidth: '100%' }}>
          <ChatImage src={msg.imageUrl} alt={msg.imageAlt} />
        </div>
      </div>
    </div>
  );
}

// ---- User message -----------------------------------------------------------

function UserMsg({ msg }: { msg: StreamMessage }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <div
        style={{
          maxWidth: '72%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 4,
        }}
      >
        {/* time + "You" header — right-aligned, time first */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--tt)' }}>{msg.time}</span>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ts)' }}>You</span>
        </div>
        {/* bubble — plain text (NOT markdown), parity with the agent UserBubble; a
            user's directive shows verbatim. pre-wrap keeps multi-line directives' breaks. */}
        <div
          style={{
            background: 'var(--elev)',
            border: '1px solid var(--border)',
            borderRadius: 11,
            borderTopRightRadius: 3,
            padding: '9px 13px',
            fontSize: 13.5,
            lineHeight: 1.55,
            color: 'var(--tp)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {msg.text}
        </div>
      </div>
    </div>
  );
}

// ---- Error notice (centered, red) -------------------------------------------
// A transient "Failed to send message" surfaced when a directive POST is rejected
// (BUG 1: previously swallowed). Mirrors the agent chat's red error footer so a failed
// send is VISIBLE instead of silently vanishing. Centered like a note, but error-toned.

function ErrorMsg({ msg }: { msg: StreamMessage }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          padding: '5px 12px',
          borderRadius: 20,
          background: 'color-mix(in srgb, var(--red) 14%, transparent)',
          border: '1px solid color-mix(in srgb, var(--red) 45%, transparent)',
          fontSize: 11.5,
          color: 'var(--red)',
          maxWidth: '80%',
        }}
      >
        <WarningCircle size={14} weight="fill" />
        {msg.text || 'Failed to send message'}
      </span>
    </div>
  );
}

// ---- Agency system notice (centered, muted) ---------------------------------
// The coordinator conversation receives injected LIFECYCLE notices about its own agents
// (posted by service.notifyCoordinatorOfAgent → they land as USER-role stream items, so
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
//   🔔 Your agent "<label>" […] is PAUSED waiting on you …         (formatAgentQuestion)
//   ⚠️ The user just <stopped|interrupted> your agent "<label>" …  (noteAgentLifecycle)
//
// 💬 (noteUserMessageToAgent — "the user just sent your agent … a message directly") is denser
// (it carries the user's actual message, which is worth keeping legible) so it gets its own
// card below — DirectMessageNoticeMsg — instead of collapsing to the one-line pill.

type NoticeIconCmp = typeof CheckCircle; // all phosphor icons share one component type

interface AgencyNotice {
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
function detectAgencyNotice(text: string): AgencyNotice | null {
  const t = text.trimStart();
  const name = firstQuoted(t);
  const agentId = parseAgentId(t);
  // ✅ finished a turn
  if (t.startsWith('✅') && /your agent|finished a turn/i.test(t)) {
    return { icon: CheckCircle, color: 'var(--acc)', summary: name ? `Agent "${name}" finished` : 'Agent finished a turn', agentId };
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

function AgencyNoticeMsg({ notice }: { notice: AgencyNotice }) {
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
          borderRadius: 20,
          background: clickable && hover ? 'var(--hover)' : 'var(--elev)',
          border: `1px solid ${clickable && hover ? 'var(--accLine)' : 'var(--border)'}`,
          fontSize: 11.5,
          color: 'var(--ts)',
          maxWidth: '86%',
          cursor: clickable ? 'pointer' : 'default',
          transition: 'background .12s, border-color .12s',
        }}
      >
        <NoticeIcon size={13} weight="fill" color={notice.color} style={{ flex: 'none' }} />
        <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{notice.summary}</span>
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

interface DirectMessageNotice {
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

function detectDirectMessageNotice(text: string): DirectMessageNotice | null {
  const t = text.trimStart();
  if (!(t.startsWith('💬') && /sent your agent/i.test(t))) return null;
  return {
    name: firstQuoted(t) || 'agent',
    mission: parseMission(t),
    quote: parseDirectMessageQuote(t) || t.replace(/^💬\s*/, ''),
    agentId: parseAgentId(t),
  };
}

function DirectMessageNoticeMsg({ notice }: { notice: DirectMessageNotice }) {
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
          borderRadius: 11,
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
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--tp)', whiteSpace: 'nowrap' }}>
            Direct message to "{notice.name}"
          </span>
          {notice.mission && (
            <span
              style={{
                fontSize: 10.5,
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
            fontSize: 12.5,
            lineHeight: 1.5,
            color: 'var(--tp)',
            paddingLeft: 20,
            borderLeft: '2px solid var(--border)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          “{notice.quote}”
        </div>
        {/* de-emphasized guidance — was the run-on sentence's tail, now a muted footnote */}
        <div style={{ fontSize: 10.5, color: 'var(--tt)', paddingLeft: 20 }}>
          This may change what you asked it to do — read how it responds and adjust.
        </div>
      </div>
    </div>
  );
}

// ---- Note pill (centered) ---------------------------------------------------

function NoteMsg({ msg }: { msg: StreamMessage }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          padding: '5px 12px',
          borderRadius: 20,
          background: 'var(--accDim)',
          border: '1px solid var(--accLine)',
          fontSize: 11.5,
          color: 'var(--ts)',
          maxWidth: '80%',
        }}
      >
        <Icon name="ph-arrow-bend-down-right" size={13} color="var(--acc)" />
        {msg.text}
      </span>
    </div>
  );
}

// ---- Stream rendering -------------------------------------------------------
// Walk the stream into MessageScroller.Items, grouping consecutive Dispatch turns
// (overseer + image) so the "Dispatch" header renders once per run. A user/note turn —
// or an empty overseer/image item that renders nothing — breaks the run. `prevDispatch`
// tracks the previously RENDERED row so a skipped (empty) item doesn't suppress the next
// real Dispatch header.

function renderStream(stream: StreamMessage[]) {
  const rows: React.ReactNode[] = [];
  let prevDispatch = false;

  for (const msg of stream) {
    if (msg.isAnsweredQuestion) {
      // The coordinator's OWN AskUserQuestion, already answered — a durable, collapsed
      // record (see live.convItemsToStream) so it stays in history instead of vanishing the
      // instant the live coordinatorPending overlay below clears.
      if (!msg.questions?.length) continue;
      rows.push(
        <MessageScroller.Item key={msg.key} messageId={msg.key} style={{ display: 'flex' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <AnsweredQuestionCard questions={msg.questions} resultText={msg.resultText ?? ''} />
          </div>
        </MessageScroller.Item>,
      );
      prevDispatch = false;
    } else if (msg.isAgentCard) {
      if (!msg.agentId) continue;
      rows.push(
        <MessageScroller.Item key={msg.key} messageId={msg.key} style={{ display: 'flex', flexDirection: 'column' }}>
          <AgentCard msg={msg} />
        </MessageScroller.Item>,
      );
      prevDispatch = false;
    } else if (msg.isImage && msg.isUser) {
      // A human-attached image — right-aligned as the user's own turn; breaks the Dispatch run.
      if (!msg.imageUrl) continue;
      rows.push(
        <MessageScroller.Item key={msg.key} messageId={msg.key} style={{ display: 'flex', flexDirection: 'column' }}>
          <UserImageMsg msg={msg} />
        </MessageScroller.Item>,
      );
      prevDispatch = false;
    } else if (msg.isOverseer) {
      if (!msg.text) continue; // renders nothing — don't push, don't touch the run
      rows.push(
        <MessageScroller.Item key={msg.key} messageId={msg.key} style={{ display: 'flex', flexDirection: 'column' }}>
          <OverseerMsg msg={msg} showHeader={!prevDispatch} />
        </MessageScroller.Item>,
      );
      prevDispatch = true;
    } else if (msg.isImage) {
      if (!msg.imageUrl) continue;
      rows.push(
        <MessageScroller.Item key={msg.key} messageId={msg.key} style={{ display: 'flex', flexDirection: 'column' }}>
          <ImageMsg msg={msg} showHeader={!prevDispatch} />
        </MessageScroller.Item>,
      );
      prevDispatch = true;
    } else if (msg.isUser) {
      // An injected agency lifecycle notice masquerades as a user turn — render it as a muted
      // system line/card, not a "You" bubble. A real user message falls through to UserMsg.
      const dmNotice = detectDirectMessageNotice(msg.text);
      const notice = dmNotice ? null : detectAgencyNotice(msg.text);
      rows.push(
        <MessageScroller.Item key={msg.key} messageId={msg.key} style={{ display: 'flex', flexDirection: 'column' }}>
          {dmNotice ? (
            <DirectMessageNoticeMsg notice={dmNotice} />
          ) : notice ? (
            <AgencyNoticeMsg notice={notice} />
          ) : (
            <UserMsg msg={msg} />
          )}
        </MessageScroller.Item>,
      );
      prevDispatch = false;
    } else if (msg.isError) {
      rows.push(
        <MessageScroller.Item key={msg.key} messageId={msg.key} style={{ display: 'flex', flexDirection: 'column' }}>
          <ErrorMsg msg={msg} />
        </MessageScroller.Item>,
      );
      prevDispatch = false;
    } else if (msg.isNote) {
      rows.push(
        <MessageScroller.Item key={msg.key} messageId={msg.key} style={{ display: 'flex', flexDirection: 'column' }}>
          <NoteMsg msg={msg} />
        </MessageScroller.Item>,
      );
      prevDispatch = false;
    }
  }
  return rows;
}

// ---- ConversationStream (exported) ------------------------------------------

export function ConversationStream() {
  const { stream, busy } = useRenderVals();
  const coordinatorId = useOverseer((s) => s.coordinatorId);
  const coordinatorPending = useOverseer((s) => s.coordinatorPending);
  const coordinatorAnswer = useOverseer((s) => s.coordinatorAnswer);
  const coordinatorHasMore = useOverseer((s) => s.coordinatorHasMore);
  const coordinatorLoadingOlder = useOverseer((s) => s.coordinatorLoadingOlder);
  const coordinatorLoadOlder = useOverseer((s) => s.coordinatorLoadOlder);

  // Reverse-infinite-scroll trigger, mirroring the agent ChatView's own onScroll threshold
  // (packages/web/src/components/tabs/chat/ChatView.tsx). preserveScrollOnPrepend on the
  // Viewport below then holds the reader's visual position across the prepend for free.
  function onViewportScroll(e: React.UIEvent<HTMLDivElement>) {
    if (e.currentTarget.scrollTop < 120 && coordinatorHasMore && !coordinatorLoadingOlder) coordinatorLoadOlder();
  }

  // `ready` gates PAINT of the scroller: hidden (visibility, not display — geometry/scroll
  // math still works) until the post-open backfill burst has fully caught up, so the reader
  // never sees the intermediate jumps land. See StickToEndOnLoad's doc comment for why this
  // is necessary even though that effect already jumps to the correct spot on every commit.
  // A stable callback: StickToEndOnLoad's effect depends on it, and an identity that changed
  // every render would re-run that effect (and re-arm its quiet-window timer) on every
  // unrelated ConversationStream re-render — never letting it settle.
  const [ready, setReady] = useState(false);
  const handleReady = useCallback(() => setReady(true), []);
  // A pending question is blocking, critical UI — the CLI is parked on stdin awaiting an answer,
  // so the stream is NOT mid-burst and there's nothing for the settle-gate to hide. Force the
  // view visible whenever one is pending so the question can never be swallowed by the paint gate.
  const hasPendingQuestion = !!coordinatorPending?.questions?.length;
  // Re-hide on a thread switch (e.g. changing projects) — a layout effect so it lands before
  // paint and the outgoing thread's "ready" state can never flash into the incoming one.
  useLayoutEffect(() => setReady(false), [coordinatorId]);

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <MessageScroller.Provider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={48}>
        <MessageScroller.Root
          style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', visibility: ready || hasPendingQuestion ? 'visible' : 'hidden' }}
        >
          <MessageScroller.Viewport preserveScrollOnPrepend onScroll={onViewportScroll} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
            <MessageScroller.Content style={{ maxWidth: 768, margin: '0 auto', padding: '20px 26px 12px', display: 'flex', flexDirection: 'column', gap: 17 }}>
              {renderStream(stream)}
              {/* The coordinator's OWN AskUserQuestion, rendered inline (mirrors the agent
                  ChatView). Answering unblocks its CLI, which is parked on stdin — without this
                  the "Open Dispatch" chat silently freezes (the question surfaces nowhere else,
                  since a coordinator is not a managed worker and useNeedsSync skips it). Keyed by
                  requestId so a new question mounts fresh. */}
              {coordinatorPending?.questions && coordinatorPending.questions.length > 0 && (
                <MessageScroller.Item messageId="__ask" style={{ display: 'flex' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <AskQuestionCard key={coordinatorPending.requestId} questions={coordinatorPending.questions} onAnswer={coordinatorAnswer} />
                  </div>
                </MessageScroller.Item>
              )}
              {/* single indeterminate spinner while the coordinator works */}
              {busy && (
                <MessageScroller.Item messageId="__working" style={{ display: 'flex' }}>
                  <WorkingIndicator />
                </MessageScroller.Item>
              )}
            </MessageScroller.Content>
          </MessageScroller.Viewport>
          {/* Floating (NOT a Content child — mirrors ChatView's LoadingOlderPill, see its
              doc comment) "Loading earlier…" pill while a loadOlder() fetch is in flight. */}
          <LoadingOlderPill show={coordinatorLoadingOlder} />
          <JumpButton />
          <StickToEndOnLoad coordinatorId={coordinatorId} count={stream.length} onReady={handleReady} />
          <BootstrapOlderPages hasMore={coordinatorHasMore} loadingOlder={coordinatorLoadingOlder} loadOlder={coordinatorLoadOlder} />
        </MessageScroller.Root>
      </MessageScroller.Provider>
      {/* Root is visibility:hidden until `ready` — surface feedback in its place so the
          settle window doesn't read as a blank freeze. Sits outside Root so it isn't hidden too. */}
      {!ready && !hasPendingQuestion && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Spinner size={20} />
        </div>
      )}
    </div>
  );
}

/**
 * Render-nothing helper: keep a freshly-opened (or freshly-switched) coordinator thread
 * pinned to the bottom through its post-mount backfill burst, and tell the parent
 * (`onReady`) once it's safe to actually PAINT the viewport.
 *
 * The scrollToEnd('auto')-per-append approach below was already correct in isolation — it
 * really does jump to the (new, longer) bottom on every single commit, instantly, never
 * smooth. It was NOT enough on its own, though: root cause (confirmed by reading the wire
 * path, not guessed) is that a long coordinator thread's replay-on-connect is not one atomic
 * burst. `structured.ts`'s replay loop `ws.send`s every buffered protocol event
 * one at a time (up to MAX_EVENTS=5000, packages/core/src/structured/manager.ts), and each
 * event that starts a new content block (a new assistant-text/tool_use/image ConvItem)
 * arrives as its own WebSocket 'message' task rather than batched with the others. Each one
 * triggers its own React commit, and this effect DOES correctly jump to the bottom on every
 * one of those commits — but the browser paints between them, so a long history's replay
 * renders as dozens-to-hundreds of individually-correct, individually-PAINTED "one step
 * further" jumps, which is visually indistinguishable from a slow continuous scroll (the
 * reported ~10s crawl). There is no competing smooth-scroll animation anywhere in this file
 * or the vendored scroller — verified: this codebase never sets `scrollAnchor` on any
 * MessageScroller.Item, so the vendored primitive's own align:'start' re-anchor path (which
 * WOULD explain a crawl) is dead code for our usage; its internal auto-scroll always targets
 * the end too, same as ours, so the two were never actually fighting.
 *
 * Fix: don't just jump correctly on every commit — HIDE every intermediate jump. Every real
 * append (while not yet revealed) restarts a short "quiet window" timer; once ~180ms passes
 * with no further growth, the burst has caught up and `onReady` fires ONCE so the parent can
 * flip the viewport from hidden to visible, landing the reader already at the bottom with
 * zero visible motion no matter how long the burst took. A count REGRESSION (ws-reconnect
 * replay clearing and re-backfilling the same thread) re-arms the latch too, so a later
 * reconnect on a still-open thread hides through ITS catch-up as well, not just the first
 * open. Once revealed, ordinary live growth (a new turn arriving seconds/minutes on) does
 * NOT re-hide the view — mirrors the agent ChatView's StickToEndOnLoad, re-armed per thread.
 */
function StickToEndOnLoad({
  coordinatorId,
  count,
  onReady,
}: {
  coordinatorId: string | null;
  count: number;
  onReady: () => void;
}) {
  const { scrollToEnd } = useMessageScroller();
  const { end } = useMessageScrollerScrollable(); // end === true ⇒ off-tail (content below the fold)
  const settledRef = useRef(false);
  const prevCountRef = useRef(-1);
  const termRef = useRef(coordinatorId);
  const readyRef = useRef(false); // latched — onReady fires at most once per catch-up
  const quietTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    // New coordinator thread → re-arm so its own backfill re-sticks to the bottom, and hide
    // again until it settles.
    if (termRef.current !== coordinatorId) {
      termRef.current = coordinatorId;
      settledRef.current = false;
      prevCountRef.current = -1;
      readyRef.current = false;
      if (quietTimerRef.current != null) { clearTimeout(quietTimerRef.current); quietTimerRef.current = null; }
    }
    // `stream` only ever GROWS or RESETS-TO-EMPTY, so a count regression unambiguously means
    // the list was cleared/replaced (ws-reconnect replay, or a remount whose outgoing count
    // still sits in prevCountRef while the new backfill climbs from 0). Re-arm so the append
    // burst exceeds prevCount and re-sticks — and re-latch the reveal gate, since a reconnect
    // on an already-open thread is its own catch-up burst that deserves the same hiding.
    if (count < prevCountRef.current) {
      prevCountRef.current = -1;
      readyRef.current = false;
    }

    // Reveal latch — independent of the scroll-follow state below (which can permanently
    // disengage once the reader scrolls up mid-burst): any real count change restarts the
    // quiet-window timer.
    if (!readyRef.current && count !== prevCountRef.current) {
      if (quietTimerRef.current != null) clearTimeout(quietTimerRef.current);
      quietTimerRef.current = setTimeout(() => {
        quietTimerRef.current = null;
        if (!readyRef.current) { readyRef.current = true; onReady(); }
      }, 180);
    }

    if (settledRef.current) return;
    if (count > prevCountRef.current) {
      // Backfill / live append while still engaged → snap to the bottom, even when `end`
      // reads off-tail: during the burst the viewport legitimately starts above the fold and
      // must be pulled down.
      prevCountRef.current = count;
      scrollToEnd({ behavior: 'auto' });
      return;
    }
    // Count held steady AND we're parked off-tail → the user scrolled up themselves.
    // Disengage for the rest of this thread; native autoScroll owns follow-while-pinned now.
    if (end) settledRef.current = true;
  }, [coordinatorId, count, end, scrollToEnd, onReady]);

  useEffect(() => () => {
    if (quietTimerRef.current != null) clearTimeout(quietTimerRef.current);
  }, []);

  return null;
}

/**
 * Render-nothing helper: pages in older coordinator history right after mount/thread-switch/
 * reconnect when the initial content is too short to overflow the viewport — otherwise the
 * reader has nothing to scroll and onViewportScroll's near-top trigger never fires, stranding
 * `hasMore: true` history that's unreachable through the UI. See useBootstrapOlderPages's
 * doc comment (shared with the agent ChatView, which has the identical gap).
 */
function BootstrapOlderPages(props: { hasMore: boolean; loadingOlder: boolean; loadOlder: () => void }) {
  useBootstrapOlderPages(props);
  return null;
}

/** Floating "Loading earlier…" pill while loadOlder() is in flight. See ChatView's
 *  LoadingOlderPill doc comment for why this stays OUTSIDE MessageScroller.Content. */
function LoadingOlderPill({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 20, background: 'var(--elev)', border: '1px solid var(--border)', color: 'var(--tt)', fontSize: 11.5, zIndex: 5, pointerEvents: 'none' }}>
      <Spinner size={11} color="var(--acc)" /> Loading earlier…
    </div>
  );
}

/** Floating "scroll to bottom" pill — shown only when the reader is off-tail. */
function JumpButton() {
  const { end } = useMessageScrollerScrollable();
  if (!end) return null;
  return (
    <MessageScroller.Button
      direction="end"
      style={{
        position: 'absolute',
        left: '50%',
        transform: 'translateX(-50%)',
        bottom: 14,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 13px',
        borderRadius: 20,
        background: 'var(--acc)',
        color: '#06140B',
        border: 'none',
        fontFamily: 'inherit',
        fontSize: 12,
        fontWeight: 600,
        boxShadow: '0 8px 22px -6px rgba(0,0,0,.7)',
        cursor: 'pointer',
        zIndex: 5,
      }}
    >
      <CaretDoubleDown size={14} weight="bold" />
      Scroll to bottom
    </MessageScroller.Button>
  );
}
