// Overseer — ConversationStream (spec §6 "Conversation stream", §7, §8).
//
// The coordinator transcript (rv.items, the same ConvItem[] a thread renders) drawn through
// the thread view's renderTimeline (components/tabs/chat/ChatView.tsx) — ONE renderer for
// both surfaces, so prose, tool strips, thinking, report_status cards, answered questions,
// footers and images look and behave exactly as they do in a thread. The Control Plane's own
// views plug in through renderTimeline's extensions (overseer/timeline.tsx): agent cards,
// agency / direct-message notices, and ledger chips.
//
// Around the list (never in it): the setup card, the canned greeting, the send-error pill,
// the live AskQuestionCard, the CompactingBar and the Working / API-retry indicator.
//
// Scroll behaviour comes from the primitive plus the thread view's shared helpers:
//   • opens at the newest message (defaultScrollPosition="end")
//   • FOLLOWS a streaming reply (the primitive watches the content height)
//   • a jump-to-latest button appears when the reader scrolls up, and they aren't yanked down
//   • StickToEndOnLoad re-sticks through the post-open backfill burst, re-arming per coordinator
//
// No prop drilling — reads the store directly.
// Desktop: flex:1 scroll (in the left conversation column). Mobile: fills the Stream tab.

import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { MessageScroller } from '@shadcn/react/message-scroller';
import { WarningCircle } from '@phosphor-icons/react';
import { ApiRetryIndicator, CompactingBar, WorkingIndicator } from '../../WorkingIndicator';
import { Spinner } from '../../common/Spinner';
import { AskQuestionCard } from '../../tabs/chat/AskQuestionCard';
import {
  AssistantText,
  BootstrapOlderPages,
  JumpButton,
  LoadEarlierButton,
  LoadingOlderPill,
  StickToEndOnLoad,
  renderTimeline,
  usePageBoundaries,
} from '../../tabs/chat/ChatView';
import { useDismissedNotices, type NoticeFilter } from '../../../stores/dismissedNotices';
import { openFileTab } from '../../../lib/openFileTab';
import { useOverseer, useRenderVals } from '../store';
import { CANNED } from '../data';
import { controlPlaneTimeline } from '../timeline';
import { ControlPlaneSetupCard } from './SetupCard';
import { useLedgerChips } from './LedgerChips';
import { useDispatchName } from '../../../stores/settings';

// ---- Error notice (centered, red) -------------------------------------------
// A transient "Failed to send message" surfaced when a directive POST is rejected
// (BUG 1: previously swallowed). Mirrors the agent chat's red error footer so a failed
// send is VISIBLE instead of silently vanishing. Centered like a note, but error-toned.

function ErrorMsg({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          padding: '5px 12px',
          borderRadius: 'var(--radius-2xl)',
          background: 'color-mix(in srgb, var(--red) 14%, transparent)',
          border: '1px solid color-mix(in srgb, var(--red) 45%, transparent)',
          fontSize: 11.5,
          color: 'var(--red)',
          maxWidth: '80%',
        }}
      >
        <WarningCircle size={14} weight="fill" />
        {text || 'Failed to send message'}
      </span>
    </div>
  );
}

// ---- ConversationStream (exported) ------------------------------------------

export function ConversationStream() {
  const dispatchName = useDispatchName();
  const { items, showGreeting, sendError, busy, projectMatches } = useRenderVals();
  // No live coordinator for this project yet (ensureForProject peeked and found none) — the
  // inline setup card replaces the (suppressed, see useRenderVals) canned greeting, so the
  // user picks the worker harness/model before anything is spawned. Read directly from the
  // store (not useRenderVals) since it's UI state, not derived transcript data.
  const setupNeeded = useOverseer((s) => s.setupNeeded);
  const coordinatorId = useOverseer((s) => s.coordinatorId);
  const coordinatorPending = useOverseer((s) => s.coordinatorPending);
  const coordinatorAnswer = useOverseer((s) => s.coordinatorAnswer);
  const replyToCoordinatorQuestion = useOverseer((s) => s.replyToCoordinatorQuestion);
  const denyCoordinatorQuestion = useOverseer((s) => s.denyCoordinatorQuestion);
  // "Older messages exist" starts true and is only corrected once a coordinator's transcript loads, so
  // a project with no coordinator yet (the setup card) has nothing to page: gate on the coordinator.
  const coordinatorHasMore = useOverseer((s) => s.coordinatorHasMore && !!s.coordinatorId);
  const coordinatorLoadingOlder = useOverseer((s) => s.coordinatorLoadingOlder);
  const coordinatorLoadOlder = useOverseer((s) => s.coordinatorLoadOlder);
  const coordinatorApiRetry = useOverseer((s) => s.coordinatorApiRetry);
  const coordinatorCompacting = useOverseer((s) => s.coordinatorCompacting);
  const coordinatorProject = useOverseer((s) => s.coordinatorProject);
  // Status cards the reader closed with ×, scoped to this coordinator (stores/dismissedNotices.ts).
  const dismissedKeys = useDismissedNotices((s) => s.keys);
  const noticeFilter = useMemo<NoticeFilter | undefined>(
    () => (coordinatorId ? { scope: coordinatorId, keys: dismissedKeys } : undefined),
    [coordinatorId, dismissedKeys],
  );
  // The shown project's ledger index for the chips — never another project's (see useLedgerChips).
  const ledger = useLedgerChips();
  // The Control Plane's hooks into renderTimeline (agent cards, notices, ledger chips).
  const ext = useMemo(() => controlPlaneTimeline(items, ledger), [items, ledger]);
  // loadOlder() page starts, as group boundaries — see usePageBoundaries.
  const pageBoundaries = usePageBoundaries(items);
  // "View file" from a machinery row: open (or reuse) the file tab in the project and
  // STAY PUT (Jason's call) — focus:false, so the Overseer is never navigated away from;
  // the tab waits on the Threads surface.
  const onViewFile = useCallback(
    (path: string) => { if (coordinatorProject) void openFileTab(coordinatorProject, path, { focus: false }); },
    [coordinatorProject],
  );

  // Reverse-infinite-scroll trigger, mirroring the agent ChatView's own onScroll threshold.
  // preserveScrollOnPrepend on the Viewport below then holds the reader's visual position
  // across the prepend for free.
  function onViewportScroll(e: React.UIEvent<HTMLDivElement>) {
    if (e.currentTarget.scrollTop < 120 && projectMatches && coordinatorHasMore && !coordinatorLoadingOlder) coordinatorLoadOlder();
  }

  // `ready` gates PAINT of the scroller: hidden (visibility, not display — geometry/scroll
  // math still works) until the post-open backfill burst has fully caught up, so the reader
  // never sees the intermediate jumps land. See ChatView's StickToEndOnLoad. A stable
  // callback: StickToEndOnLoad's effect depends on it.
  const [ready, setReady] = useState(false);
  const handleReady = useCallback(() => setReady(true), []);
  // A pending question is blocking, critical UI — the CLI is parked on stdin awaiting an answer,
  // so the stream is NOT mid-burst and there's nothing for the settle-gate to hide. Force the
  // view visible whenever one is pending so the question can never be swallowed by the paint gate.
  const hasPendingQuestion = projectMatches && !!coordinatorPending?.questions?.length;
  // Re-hide on a thread switch (e.g. changing projects) — a layout effect so it lands before
  // paint and the outgoing thread's "ready" state can never flash into the incoming one.
  // NOTE: coordinatorId is read RAW (ungated) on purpose — it's a thread-IDENTITY signal for the
  // scroll/paint machinery (re-arm the latch, reset `ready`), never rendered transcript content.
  // The content reads above are project-gated; this identity read must not be, or the paint gate
  // wouldn't re-arm across the swap. Don't "fix" this to projectMatches — it's not a content leak.
  useLayoutEffect(() => setReady(false), [coordinatorId]);
  // What StickToEndOnLoad counts: the transcript plus the rows drawn around it.
  const rowCount = items.length + (showGreeting ? 1 : 0) + (sendError ? 1 : 0);

  return (
    // chat-scope: the thread view's box/border defaults, which its timeline pieces assume.
    <div className="chat-scope" style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <MessageScroller.Provider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={48}>
        <MessageScroller.Root
          style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, display: 'flex', visibility: ready || hasPendingQuestion ? 'visible' : 'hidden' }}
        >
          <MessageScroller.Viewport preserveScrollOnPrepend onScroll={onViewportScroll} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
            {/* The thread view's column (ChatView): same width and side padding, which its
                full-bleed machinery strips are measured against. */}
            <MessageScroller.Content style={{ maxWidth: 768, margin: '0 auto', padding: '24px 20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* No coordinator yet for this project — the inline setup card stands in for
                  the message list (and the suppressed canned greeting, see useRenderVals)
                  until the user picks a worker harness/model and hits Start. Belt-and-braces
                  on `!coordinatorId`: a stale peek landing after startCoordinator already set
                  a live coordinatorId must never re-show the card even if setupNeeded briefly
                  glitches true again (see ensureGeneration in store.ts for the actual fix). */}
              {setupNeeded && !coordinatorId && <ControlPlaneSetupCard />}
              {/* Explicit older-history control (parity with ChatView's LoadEarlierButton, see
                  its doc comment). Gated on projectMatches like every other coordinator read
                  (the cross-tab bleed fix). */}
              <LoadEarlierButton show={projectMatches && coordinatorHasMore && !coordinatorLoadingOlder} onClick={coordinatorLoadOlder} />
              {/* First-run / empty conversation: the Control Plane introduces itself, drawn as
                  an assistant turn. Not part of the transcript. */}
              {showGreeting && (
                <MessageScroller.Item messageId="__greeting" style={{ display: 'flex', flexDirection: 'column' }}>
                  <AssistantText text={CANNED.emptyGreeting(dispatchName)} />
                </MessageScroller.Item>
              )}
              {renderTimeline(items, onViewFile, pageBoundaries, undefined, null, noticeFilter, ext)}
              {sendError && (
                <MessageScroller.Item messageId="__send-error" style={{ display: 'flex', flexDirection: 'column' }}>
                  <ErrorMsg text={sendError} />
                </MessageScroller.Item>
              )}
              {/* The coordinator's OWN AskUserQuestion, rendered inline (mirrors the agent
                  ChatView). Answering unblocks its CLI, which is parked on stdin — without this
                  the "Open Dispatch" chat silently freezes (the question surfaces nowhere else,
                  since a coordinator is not a managed worker and useNeedsSync skips it). Keyed by
                  requestId so a new question mounts fresh. */}
              {projectMatches && coordinatorPending?.questions && coordinatorPending.questions.length > 0 && (
                <MessageScroller.Item messageId="__ask" style={{ display: 'flex' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <AskQuestionCard key={coordinatorPending.requestId} questions={coordinatorPending.questions} onAnswer={coordinatorAnswer} onReply={replyToCoordinatorQuestion} onDeny={denyCoordinatorQuestion} />
                  </div>
                </MessageScroller.Item>
              )}
              {/* Native /compact in progress — the same bar the agent ChatView shows, so a
                  minutes-long compaction never reads as a dead session. queued={0}: the
                  queued-turn split ChatView does is not reproduced here — messages sent
                  meanwhile still queue on stdin. Gated on projectMatches like every direct
                  coordinator store read. */}
              {projectMatches && coordinatorCompacting && (
                <MessageScroller.Item messageId="__compacting" style={{ display: 'flex' }}>
                  <CompactingBar queued={0} />
                </MessageScroller.Item>
              )}
              {/* single indeterminate spinner while the coordinator works */}
              {busy && (
                <MessageScroller.Item messageId="__working" style={{ display: 'flex' }}>
                  {/* Name a model-call retry instead of a bare spinner — during an outage the
                      CLI retries for minutes and "Working…" reads as a dead session. Gated on
                      projectMatches like every coordinator read (busy already is, via
                      useRenderVals; the direct store read here needs its own gate). */}
                  {projectMatches && coordinatorApiRetry ? <ApiRetryIndicator retry={coordinatorApiRetry} /> : <WorkingIndicator />}
                </MessageScroller.Item>
              )}
            </MessageScroller.Content>
          </MessageScroller.Viewport>
          {/* Floating (NOT a Content child — see LoadingOlderPill's doc comment) "Loading
              earlier…" pill while a loadOlder() fetch is in flight. */}
          <LoadingOlderPill show={coordinatorLoadingOlder} />
          <JumpButton />
          <StickToEndOnLoad terminalId={coordinatorId} count={rowCount} onReady={handleReady} />
          <BootstrapOlderPages hasMore={projectMatches && coordinatorHasMore} loadingOlder={coordinatorLoadingOlder} loadOlder={coordinatorLoadOlder} />
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
