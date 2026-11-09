import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { SignedOutCard } from './SignedOutCard';
import { ModelSwitcher } from './ModelSwitcher';
import { isClaudeAuthError } from '../../endless/ClaudeLogin';
import { MessageScroller } from '@shadcn/react/message-scroller';
import { X } from '@phosphor-icons/react';
import type { ConvItem } from '../../../api/types';
import { api, type ContentBlock } from '../../../api/client';
import { useStructuredChat } from './useStructuredChat';
import { AskQuestionCard } from './AskQuestionCard';
import { useDismissedNotices, type NoticeFilter } from '../../../stores/dismissedNotices';
import { useTabs, findTerminal } from '../../../stores/tabs';
import { useConnection } from '../../../stores/connection';
import { useDraft } from '../../../hooks/useDraft';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { useSettings } from '../../../stores/settings';
import { useDictation } from '../../../hooks/useDictation';
import { PillComposer } from '../../composer/PillComposer';
import { UploadTray, useInboxUploads } from '../../composer/UploadTray';
import { ThreadDocsContext, useThreadDocChips } from '../../threadDocs';
import { DocViewer } from '../../endless/DocViewer';
import { ResumeAdviceCard } from './ResumeAdviceCard';
import { WorkingIndicator, CompactingBar, ApiRetryIndicator } from '../../WorkingIndicator';
import { Spinner } from '../../common/Spinner';
import { ContextIndicator } from '../../ContextIndicator';
import { useThreadModelControls } from './modelControls';
import { useSlashMenu, runModelEffortCommand } from '../../composer/slash/useSlashMenu';
import { usePickerRequest } from '../../../stores/pickerRequest';
import { useTransportSwitch } from '../../layout/TransportToggle';
import { ConfirmModal } from '../../common/ConfirmModal';
import { textToSend } from '../../../lib/slashEscape';
import { modLabel } from '../../../lib/hostkeys';
import { openFileTab } from '../../../lib/openFileTab';
import { renderTimeline, EmptyState, ReconnectingState, StickToEndOnLoad, BootstrapOlderPages, LoadEarlierButton, LoadingOlderPill, JumpButton } from './timeline';
import { MODEL_IMAGE_MIME, fileToBase64 } from '../../../lib/image-attach';

/**
 * ChatView — the structured (stream-json) thread surface, built on shadcn's
 * MessageScroller chat primitive. Structured threads have no PTY, so this IS the
 * thread (no Terminal mode). Live events + optimistic user turns come from
 * useStructuredChat; tool calls are paired with their results by id.
 */
export function ChatView({ terminalId }: { terminalId: string }) {
  const tab = useTabs((s) => findTerminal(s.byProject, terminalId));
  const sessionId = tab?.sessionId;
  // A thread Chat started shows Chat's messages as "VIA CHAT", not the Control Plane's name.
  const relayName = relayNameFor(tab);
  const connStatus = useConnection((s) => s.status);
  // The ACP harnesses (grok, opencode) have no pageable REST transcript (getConversation →
  // unsupported): their full ws-ring replay IS the whole recoverable history, so the
  // older-pages machinery stays off — no phantom "Load earlier messages" on a thread with
  // nothing earlier to load. An unresolved tab keeps the pageable default (claude-code is
  // the common case).
  const { items, busy, model, authRequired, send, pending, answer, replyFromCard, denyFromCard, contextTokens, contextWindow, compacting, compactResult, apiRetry, compact, hasMore, loadingOlder, loadOlder } =
    useStructuredChat(terminalId, sessionId, { pageableHistory: tab?.type !== 'grok' && tab?.type !== 'opencode' });
  const loginItem = useMemo(() => loginItemFor(tab?.type, items, !!authRequired), [tab?.type, items, authRequired]);
  // Retry after a sign-in: the last message the owner sent, again (SignedOutCard says why it is a button).
  const retryLast = useCallback(() => {
    for (let k = items.length - 1; k >= 0; k--) {
      const it = items[k];
      if (it.kind === 'user' && it.source !== 'coordinator' && it.text) { send(it.text); return; }
    }
  }, [items, send]);
  const authHidden = useMemo(() => (authRequired ? authProseToHide(items, loginItem) : new Set<ConvItem>()), [authRequired, items, loginItem]);
  const shown = useCallback((list: ConvItem[]) => (authHidden.size ? list.filter((it) => !authHidden.has(it)) : list), [authHidden]);
  const authExt = useMemo(() => (authRequired && tab ? { authCard: <SignedOutCard tab={tab} auth={authRequired} onRetry={retryLast} /> } : undefined), [authRequired, tab, retryLast]);

  // Advice is about THIS resume, so "not now" lives in component state rather than
  // storage: a later resume of the same thread (older and larger still) should ask again.
  const [advice, setAdvice] = useState<{ ageMinutes: number; contextTokens: number } | null>(null);
  const [adviceError, setAdviceError] = useState<string | null>(null);
  // Per-thread "Resume full session" dismissals. Also NOT persisted (same reasoning as
  // `advice` above), but keyed by terminal id so it survives an in-place terminalId switch:
  // PaneTree/PaneFrame render <TabHost terminalId={tabId}/> with no `key`, so dismissing on
  // thread A, switching to B, and switching back to A reuses this SAME ChatView instance —
  // without remembering A's dismissal here, the effect below would just re-fetch and show
  // the card again.
  const [dismissedFullIds, setDismissedFullIds] = useState<Set<string>>(new Set());
  // Always-current terminalId, for the compact staleness guard in onSummarize below — that
  // callback can fire (a rejection) long after a later render has replaced the closure that
  // registered it, once the reader has already switched to a different thread.
  const terminalIdRef = useRef(terminalId); terminalIdRef.current = terminalId;

  // Where the timeline splits while a compaction runs: the item count at the moment
  // `compacting` flipped true, remembered per terminal. Turns echoed AFTER that point
  // are ones the CLI is holding on stdin until the compaction ends — rendering them
  // BELOW the CompactingBar (rather than above, in plain arrival order) is what tells
  // the reader "these send when compacting finishes". Render-time mutation is safe
  // here: the write is idempotent for a given (terminalId, compacting) pair, and the
  // hook resets `compacting` on replay/terminal switch, which clears the split.
  const compactSplit = useRef<{ id: string; index: number } | null>(null);
  if (compacting) {
    if (!compactSplit.current || compactSplit.current.id !== terminalId) compactSplit.current = { id: terminalId, index: items.length };
  } else {
    compactSplit.current = null;
  }
  const splitIdx = compactSplit.current ? Math.min(compactSplit.current.index, items.length) : null;

  useEffect(() => {
    // Clear any stale advice/error from a PREVIOUS terminalId before anything else — PaneTree/
    // PaneFrame render <TabHost terminalId={tabId}/> with no `key`, so switching a pane's tab
    // in place updates terminalId on this SAME ChatView instance rather than remounting it.
    // Without this, thread A's card (its age/token numbers) would keep rendering under thread
    // B's identity until B's own advice happened to resolve with shouldPrompt: true.
    setAdvice(null);
    setAdviceError(null);
    if (dismissedFullIds.has(terminalId)) return;
    let cancelled = false;
    api.getResumeAdvice(terminalId)
      .then((a) => { if (!cancelled && a.shouldPrompt) setAdvice({ ageMinutes: a.ageMinutes, contextTokens: a.contextTokens }); })
      .catch(() => { /* advisory only — never block the chat on it */ });
    return () => { cancelled = true; };
  }, [terminalId, dismissedFullIds]);

  // Reverse-infinite-scroll: fetch the next older page once the reader nears the top.
  // Mirrors ConversationView's own `scrollTop < 120` threshold; MessageScroller.Viewport's
  // `preserveScrollOnPrepend` (below) then holds the reader's visual position across the
  // prepend with no scroll math of our own needed.
  function onViewportScroll(e: React.UIEvent<HTMLDivElement>) {
    if (e.currentTarget.scrollTop < 120 && hasMore && !loadingOlder) loadOlder();
  }

  // loadOlder() page starts, as permanent group boundaries for renderTimeline (see usePageBoundaries).
  const pageBoundaries = usePageBoundaries(items);

  const [draft, setDraft, clearDraft] = useDraft(terminalId);
  // Status cards the reader closed with ×, scoped to this thread (stores/dismissedNotices.ts).
  const dismissedKeys = useDismissedNotices((s) => s.keys);
  const noticeFilter = useMemo<NoticeFilter>(() => ({ scope: terminalId, keys: dismissedKeys }), [terminalId, dismissedKeys]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Mirror the draft in a ref so the async upload loop appends to the latest value
  // (across awaits / multiple files) without clobbering what's already there.
  const draftRef = useRef(draft); draftRef.current = draft;
  const [dragActive, setDragActive] = useState(false); // drives the drop-target visual cue
  // Images picked / dropped / PASTED are STAGED here as real base64 content blocks and ride
  // out with the next doSend() as ONE turn — instead of each firing its own message the moment
  // it's attached (which is what made a pasted screenshot jump straight into the chat before you
  // could add a caption). Mirrors the coordinator Composer's composerImages buffer.
  const [stagedImages, setStagedImages] = useState<ContentBlock[]>([]);

  // Mobile voice dictation. The composer's left control becomes a + flyout (Add file /
  // Dictate); choosing Dictate swaps the textarea for the recording UI, and the confirmed
  // transcript is appended to the current draft. Desktop is unaffected.
  const isMobile = useIsMobile();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sttConfigured = useSettings((s) => !!s.sttProvider && !!s.sttModel && !!s.sttSecretName);
  const dictation = useDictation((text) => {
    const next = (draftRef.current ? draftRef.current + ' ' : '') + text;
    draftRef.current = next; setDraft(next);
  });

  /**
   * "Resume full session", by button or by just sending (2026-11-06): a message sent while
   * the card shows resumes the full session anyway, so the decision is made and the card
   * goes. Remembered per thread, so switching away and back (in place — see the
   * dismissedFullIds doc comment above) doesn't bring the card back for THIS resume. Not
   * persisted: a later resume of the same thread should ask again.
   */
  function dismissResumeAdvice() {
    setAdvice(null);
    setDismissedFullIds((prev) => (prev.has(terminalId) ? prev : new Set(prev).add(terminalId)));
  }

  function doSend() {
    // A command typed in the box (/model, /compact…) is Dispatch's to run, never the model's.
    if (slash.interceptSend()) return;
    const v = textToSend(draft);
    if (!v && stagedImages.length === 0) return;
    if (advice) dismissResumeAdvice();
    // Text + any staged images go out as ONE turn: a leading text block (when there's a
    // caption) followed by the image blocks. Falls back to a plain string turn when nothing
    // is staged, matching the previous behavior for text-only sends.
    if (stagedImages.length) {
      send(v ? [{ type: 'text', text: v }, ...stagedImages] : [...stagedImages]);
      setStagedImages([]);
    } else {
      send(v);
    }
    clearDraft();
  }

  // Upload each picked file to the project inbox. An IMAGE is then STAGED as a REAL base64
  // content block (see stagedImages) so it rides out with the user's next message as one
  // turn — and it echoes back + renders inline via the foundation's parser. A non-image keeps
  // the path-reference line in the draft so the user sends the path alongside their message
  // (the agent can Read it).
  // Each upload shows a progress tile with a cancel (composer/UploadTray.tsx).
  const uploader = useInboxUploads(sessionId, async (res, f) => {
    if (MODEL_IMAGE_MIME.has(f.type)) {
      const data = await fileToBase64(f);
      const block: ContentBlock = { type: 'image', source: { type: 'base64', media_type: f.type, data } };
      setStagedImages((prev) => [...prev, block]);
    } else {
      const cur = draftRef.current;
      const next = cur + (cur ? '\n' : '') + 'Attached file: ' + res.path;
      draftRef.current = next;
      setDraft(next);
    }
  });
  async function attachFiles(files: FileList | null) {
    if (!files || !files.length || !sessionId) return;
    for (const f of Array.from(files)) uploader.start(f);
  }

  // Drag-and-drop + paste image upload — route dropped/pasted files through the SAME
  // attachFiles path as the Paperclip (upload to inbox; an image rides along as a real
  // base64 block so the model SEES it). Mirrors the coordinator Composer + TerminalTab.
  // Gate on a FILE drag so the cue doesn't flash on text/element drags.
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    setDragActive(true);
  }
  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    // Only clear when the pointer truly leaves the composer (not when crossing a child),
    // so the cue doesn't flicker between the attach button / textarea / send button.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragActive(false);
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files?.length) void attachFiles(e.dataTransfer.files);
  }
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = e.clipboardData?.files;
    if (files && files.length) { e.preventDefault(); void attachFiles(files); }
  }

  async function openFileInViewer(path: string) {
    if (!sessionId) return;
    // focus:true — you're on the Threads surface, so the file comes to front. (The
    // Control Plane calls the same helper with focus:false and stays put.)
    await openFileTab(sessionId, path, { focus: true });
  }

  // Send is enabled by EITHER a non-empty draft OR at least one staged image (a screenshot
  // with no caption is a valid turn on its own).
  const canSend = draft.trim().length > 0 || stagedImages.length > 0;
  // The composer key doubles as the turn's brake. It offers Stop in the ONE state where
  // there is nothing to send and something worth stopping: a turn in flight over an empty
  // composer. Typing always wins — a mid-turn follow-up (the CLI queues it as its own turn)
  // must never be blocked by the key having become a Stop. Deliberately keyed on `busy`
  // alone: a native compaction is left to finish, since interrupting one mid-way is messy.
  const stopMode = busy && !canSend;
  function doStop() {
    // Graceful: ends the CURRENT TURN and leaves the thread alive (Claude gets the
    // stream-json `interrupt` control, Codex `turn/interrupt`). Deliberately not
    // api.stopTerminal, which kills the process.
    api.interrupt(terminalId).catch(() => { /* best-effort — nothing live to interrupt */ });
  }
  // The "/" menu (composer/slash): Dispatch's own commands for this thread. /model and /effort use the chip's lists and
  // calls (modelControls.ts); a bare one opens the chip's card. Mid-turn they fail like the chip is disabled: the daemon
  // answers "busy" and the typed text stays in the box. /cli asks first when the thread is working, like the CLI/Pretty switch.
  const controls = useThreadModelControls(tab ?? { id: terminalId, sessionId: '', type: 'claude-code', config: {} });
  const transport = useTransportSwitch(terminalId);
  const slashHarness = controls.harness ?? 'claude-code';
  // A turn parked on a question is still a turn that runs (the daemon answers 409 then too), so the chip is off for it as well.
  const [askRestart, setAskRestart] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const turnRuns = busy || compacting || !!pending || tab?.status === 'needs_input';
  const slash = useSlashMenu({
    surface: 'thread', harness: slashHarness, value: draft, setValue: setDraft, mobile: isMobile,
    model: controls.active ?? null, effort: controls.effort?.current ?? controls.effort?.defaultEffort ?? null,
    models: controls.options, effortLevels: controls.effort?.levels,
    run: async (name, args) => {
      if (name === 'model' || name === 'effort') {
        return runModelEffortCommand({
          harness: slashHarness, name, args, models: controls.options, effortLevels: controls.effort?.levels,
          openPicker: () => {
            if (turnRuns) throw new Error(`This thread is busy — change the ${name} when the turn ends`);
            usePickerRequest.getState().request(`thread:${terminalId}`);
          },
          pickModel: controls.pickModel, pickEffort: controls.pickEffort,
        });
      }
      if (name === 'compact') { await api.compactTerminal(terminalId); return; }
      if (name === 'stop') { await api.interrupt(terminalId); return; }
      if (name === 'cli') {
        if (!transport.canSwitch) throw new Error(transport.tip ?? 'This thread cannot switch to the CLI right now.');
        const why = await transport.request('cli');
        if (why) { transport.clearError(); throw new Error(why); } // shown as the menu's own notice, and the text stays
        return;
      }
      if (name === 'restart') {
        // Always ask first, idle or working, from the menu and from the phone's Commands sheet alike. The modal's wording follows the live turn state.
        setAskRestart(true);
        return;
      }
    },
  });
  // Composer key size: 44px on mobile — the platform minimum touch target; the 34px keys
  // were "too small and too hard to press" (David, on-device). Desktop keeps the tighter 34.

  // Paint-settle gate (back-port of the Control Plane Stream's reveal latch): the scroller
  // stays visibility:hidden until the open/reconnect replay burst settles, so the reader
  // lands at the bottom with zero visible catch-up motion. A pending question forces the
  // view visible — the CLI is parked on stdin, nothing is bursting, and the question must
  // never be swallowed by the gate. See StickToEndOnLoad for the full mechanics.
  const [ready, setReady] = useState(false);
  const handleReady = useCallback(() => setReady(true), []);
  const hasPendingQuestion = !!pending?.questions?.length;
  // Doc chips and link clicks in this thread's messages, whichever harness wrote them.
  const threadDocs = useThreadDocChips(sessionId, terminalId);
  // Re-hide on an in-place thread switch — a layout effect so it lands before paint.
  useLayoutEffect(() => setReady(false), [terminalId]);

  return (
    <ThreadDocsContext.Provider value={threadDocs}>
    <div className="chat-scope" style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, background: 'var(--color-base)' }}>
      <MessageScroller.Provider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={48}>
        {/* The wrapper (not Root) hosts the not-ready spinner so it isn't hidden with the
            scroller; visibility (not display) keeps geometry/scroll math working while hidden. */}
        {/* minWidth: 0 on this row chain is REQUIRED: without it the flex items refuse to
            shrink below their content's min-content width, so one long unbreakable token in
            any message (a joined identifier in inline code) silently widens the whole column
            past a phone's viewport and every paragraph wraps at the token's width instead of
            the screen's (the iPhone SE cut-off bug). Only the wrapper and Root need it — the
            Viewport is overflow-hidden, which already zeroes its automatic minimum size. */}
        <div style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
        <MessageScroller.Root style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, display: 'flex', visibility: ready || hasPendingQuestion ? 'visible' : 'hidden' }}>
          <MessageScroller.Viewport preserveScrollOnPrepend onScroll={onViewportScroll} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
            {/* Bottom padding matches the top: the last row — usually the Working… indicator —
                used to sit 8px off the composer, which read as cramped on a phone. */}
            <MessageScroller.Content style={{ maxWidth: 768, margin: '0 auto', padding: '24px 20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              <LoadEarlierButton show={hasMore && !loadingOlder} onClick={loadOlder} />
              {/* An empty item list means "no messages yet" ONLY when the socket is open.
                  While it's still (re)connecting, the history simply hasn't replayed —
                  showing "send a message to start" over a thread that may be full of
                  messages is a lie, so that state gets a centered reconnect spinner. */}
              {items.length === 0 && !busy && !compacting && (connStatus === 'open' ? <EmptyState model={model} /> : <ReconnectingState />)}
              {splitIdx === null ? (
                renderTimeline(shown(items), openFileInViewer, pageBoundaries, relayName, loginItem, noticeFilter, authExt)
              ) : (
                <>
                  {/* Mid-compaction: the bar is a full-width divider pinned at the point the
                      compaction began. Turns echoed after it (held on the CLI's stdin) render
                      below, so their position says "queued". The split is render-only — when
                      `compacting` clears, the timeline re-merges into one render and tool/result
                      pairing across the boundary works again. */}
                  {renderTimeline(shown(items.slice(0, splitIdx)), openFileInViewer, pageBoundaries, relayName, loginItem, noticeFilter, authExt)}
                  <MessageScroller.Item messageId="__compacting" style={{ display: 'flex' }}>
                    <CompactingBar queued={items.length - splitIdx} />
                  </MessageScroller.Item>
                  {renderTimeline(shown(items.slice(splitIdx)), openFileInViewer, pageBoundaries, relayName, loginItem, undefined, authExt)}
                </>
              )}
              {pending?.questions && pending.questions.length > 0 && (
                <MessageScroller.Item messageId="__ask" style={{ display: 'flex' }}>
                  {/* Interactive AskUserQuestion — answering unblocks the CLI (which is
                      parked on stdin). Keyed by requestId so a new question mounts fresh. */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <AskQuestionCard key={pending.requestId} questions={pending.questions} onAnswer={answer} onReply={replyFromCard} onDeny={denyFromCard} />
                  </div>
                </MessageScroller.Item>
              )}
              {busy && !compacting && (
                <MessageScroller.Item messageId="__working" style={{ display: 'flex' }}>
                  {/* While compacting, the full-width CompactingBar (in the timeline above)
                      owns the state — a second spinner down here would read as "answering". */}
                  {apiRetry ? <ApiRetryIndicator retry={apiRetry} /> : <WorkingIndicator />}
                </MessageScroller.Item>
              )}
            </MessageScroller.Content>
          </MessageScroller.Viewport>
          {/* Floating (NOT a Content child — see LoadingOlderPill's doc comment for why)
              "Loading earlier…" pill while a loadOlder() fetch is in flight. */}
          <LoadingOlderPill show={loadingOlder} />
          <JumpButton />
          <StickToEndOnLoad terminalId={terminalId} count={items.length} onReady={handleReady} />
          <BootstrapOlderPages hasMore={hasMore} loadingOlder={loadingOlder} loadOlder={loadOlder} />
        </MessageScroller.Root>
        {!ready && !hasPendingQuestion && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Spinner size={20} />
          </div>
        )}
        </div>
      </MessageScroller.Provider>

      {/* Dismissible "resume from summary?" card, above the composer (not inside it — see
          ResumeAdviceCard's doc comment for why this exists at all). */}
      {(adviceError || advice) && (
        <div style={{ flexShrink: 0, padding: '10px 14px 0' }}>
          {adviceError && (
            <div style={{ maxWidth: 768, margin: '0 auto 8px', font: '400 12px var(--font-sans)', color: 'var(--color-status-red)' }}>
              Couldn't summarize: {adviceError}
            </div>
          )}
          {advice && (
            <ResumeAdviceCard
              ageMinutes={advice.ageMinutes}
              contextTokens={advice.contextTokens}
              onSummarize={() => {
                // Direct call, not useStructuredChat's fire-and-forget `compact()`: a thread
                // whose structured session isn't live answers 409, and that must be visible
                // rather than looking like a summarization that quietly did nothing.
                setAdvice(null);
                setAdviceError(null);
                // Staleness guard: capture the terminal this request is FOR, and compare
                // against the always-current terminalIdRef when the response lands — the
                // daemon can answer (e.g. a 409) well after the reader has switched to a
                // different thread, and that error must not render under the new thread's
                // identity.
                const requestedTerminalId = terminalId;
                api.compactTerminal(terminalId).catch((e: any) => {
                  if (terminalIdRef.current !== requestedTerminalId) return;
                  setAdviceError(e?.message ?? String(e));
                });
              }}
              onFull={dismissResumeAdvice}
            />
          )}
        </div>
      )}

      {/* Safety net: if this thread declared a needs_you question via report_status (which only
          lands on the status/board channel, never in the transcript), surface it right above the
          composer so it isn't invisible in thread mode. */}

      {/* Composer (drop a file anywhere on it, or paste — routes through attachFiles) */}
      <div
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        style={{ flexShrink: 0, borderTop: '1px solid var(--color-border)', background: 'var(--color-pane)', padding: '10px 14px max(10px, var(--composer-safe-bottom, env(safe-area-inset-bottom)))' }}
      >
        {dragActive && (
          <div style={{ maxWidth: 768, margin: '0 auto 6px', fontSize: 12, color: 'var(--color-accent)' }}>Drop image to attach</div>
        )}
        <div style={{ maxWidth: 768, margin: '0 auto' }}><UploadTray uploads={uploader.uploads} onCancel={uploader.cancel} /></div>
        {/* Staged image thumbnails — each removable via its ×; they send with the next message.
            Hidden behind the drag cue so the two don't fight for the same strip. */}
        {!dragActive && stagedImages.length > 0 && (
          <div style={{ maxWidth: 768, margin: '0 auto 8px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {stagedImages.map((block, i) =>
              block.type === 'image' ? (
                <StagedThumbnail
                  key={i}
                  src={`data:${block.source.media_type};base64,${block.source.data}`}
                  onRemove={() => setStagedImages((prev) => prev.filter((_, j) => j !== i))}
                />
              ) : null,
            )}
          </div>
        )}
        {/* The shared composer (composer/PillComposer.tsx): + | text | mic | ↑, on desktop and phone. */}
        <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { void attachFiles(e.target.files); e.currentTarget.value = ''; }} />
        <div style={{ maxWidth: 768, margin: '0 auto' }}>
          <PillComposer
            value={draft}
            onChange={setDraft}
            onSend={doSend}
            /* Not while an upload runs: its image would miss this message. */
            canSend={canSend && !uploader.busy}
            stopMode={stopMode}
            onStop={doStop}
            placeholder="Message…"
            pluginContext={{ surface: 'thread', terminalId, sessionId }}
            onAddFile={() => fileInputRef.current?.click()}
            dictation={dictation}
            sttConfigured={sttConfigured}
            textareaRef={taRef}
            /* Prose only, so spelling help is on. autoCapitalize stays off so a path or a
               command name pasted mid-message is not altered. */
            textareaProps={{ onPaste, onKeyDown: slash.onKeyDown, autoCapitalize: 'off', autoCorrect: 'on', spellCheck: true }}
            dragActive={dragActive}
            mobile={isMobile}
            menuExtra={slash.plusRow}
            slash={slash.overlay}
          />
        </div>

        {/* thin status row: muted context-window fill indicator, tappable for detail */}
        <div style={{ maxWidth: 768, margin: '6px auto 0', display: 'flex', alignItems: 'center' }}>
          {/* The active model, always shown once a thread has one, and the switcher behind it. */}
          {tab && tab.type !== 'shell' && <ModelSwitcher tab={tab} busy={turnRuns} />}
          {/* OS-aware send hint (Control Plane parity): ⌘↵ on a Mac, Ctrl+↵ elsewhere. */}
          {!isMobile && (
            <span style={{ font: '400 10px var(--font-mono)', color: 'var(--color-text-tertiary)', marginLeft: 10 }}>{modLabel('↵')} send</span>
          )}
          <span style={{ marginLeft: 'auto' }} />
          <ContextIndicator contextTokens={contextTokens} contextWindow={contextWindow} compacting={compacting} compactResult={compactResult} model={model} terminalId={terminalId} compact={compact} showModel={false} />
        </div>
      </div>
      {transport.confirmUi}
      {restartError && (
        <div role="alert" style={{ flexShrink: 0, display: 'flex', alignItems: 'flex-start', gap: 8, padding: '4px 14px', font: '400 12.5px var(--font-sans)', color: 'var(--color-status-red)' }}>
          <span style={{ flex: 1, minWidth: 0 }}>Could not restart: {restartError}</span>
          <button type="button" aria-label="Dismiss" title="Dismiss" onClick={() => setRestartError(null)}
            style={{ flex: 'none', padding: 2, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', display: 'flex' }}>
            <X size={13} weight="bold" />
          </button>
        </div>
      )}
      <ConfirmModal
        open={askRestart}
        title={turnRuns ? 'Restart this thread now?' : 'Restart this thread?'}
        message={turnRuns
          ? 'This thread is working. Restarting stops the current turn and starts the thread again, carrying on the same conversation. What it was in the middle of will not finish.'
          : 'The thread starts again and carries on the same conversation.'}
        confirmLabel={turnRuns ? 'Stop and restart' : 'Restart'}
        onConfirm={() => { setAskRestart(false); setRestartError(null); api.relaunchTerminal(terminalId).catch((e) => setRestartError(e instanceof Error ? e.message : 'The thread could not be restarted.')); }}
        onCancel={() => setAskRestart(false)}
      />
      {transport.error && (
        <div role="alert" style={{ flexShrink: 0, display: 'flex', alignItems: 'flex-start', gap: 8, padding: '4px 14px', font: '400 12.5px var(--font-sans)', color: 'var(--color-status-red)' }}>
          <span style={{ flex: 1, minWidth: 0 }}>Could not switch: {transport.error}</span>
          <button type="button" aria-label="Dismiss" title="Dismiss" onClick={transport.clearError}
            style={{ flex: 'none', padding: 2, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', display: 'flex' }}>
            <X size={13} weight="bold" />
          </button>
        </div>
      )}
      <DocViewer owner={terminalId} />
    </div>
    </ThreadDocsContext.Provider>
  );
}


/**
 * Detect a loadOlder() prepend (items[0] changed, but the array isn't a full reset — the
 * PREVIOUS first item is still present somewhere later on) and remember that previous
 * first item as a permanent group boundary. Without this, renderTimeline's turn-grouping
 * would silently MERGE the newly-prepended older content into whatever group used to start
 * the array — same top-level DOM node, just grown taller in place — which MessageScroller's
 * preserveScrollOnPrepend can't compensate for (it only recognizes a prepend as NEW SIBLING
 * nodes appearing before an unmoved existing one, not an existing node silently growing).
 * Forcing a flush at each boundary turns every older page into its own new sibling group
 * instead, matching what the scroller expects — see its use in renderTimeline. Plain ref
 * writes during render (no effect), because renderTimeline() must see this render's
 * boundary. Shared by every surface that renders through renderTimeline (the thread
 * ChatView and the Control Plane's ConversationStream).
 */
export function usePageBoundaries(items: ConvItem[]): Set<ConvItem> {
  const prevItemsRef = useRef<ConvItem[]>([]);
  const pageBoundariesRef = useRef<Set<ConvItem>>(new Set());
  if (items.length && prevItemsRef.current.length && items[0] !== prevItemsRef.current[0]) {
    pageBoundariesRef.current.add(prevItemsRef.current[0]);
  }
  prevItemsRef.current = items;
  return pageBoundariesRef.current;
}


/** A staged (pre-send) image preview with an × to drop it before sending. Mirrors the
 *  coordinator Composer's StagedThumbnail (packages/web/src/components/overseer/components/Composer.tsx). */
function StagedThumbnail({ src, onRemove }: { src: string; onRemove: () => void }) {
  return (
    <div style={{ position: 'relative', width: 48, height: 48, flex: 'none' }}>
      <img src={src} alt="attachment" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', display: 'block' }} />
      <button
        type="button"
        onClick={onRemove}
        title="Remove image"
        style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, padding: 0, borderRadius: '50%', background: 'var(--color-base)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}
      >
        <X size={11} weight="bold" />
      </button>
    </div>
  );
}

/** Who relayed a coordinator-sent turn in this thread: 'Chat' for a thread Chat started, else the Dispatch name. */
export function relayNameFor(tab: { config?: Record<string, unknown> } | null | undefined): string | undefined {
  return tab?.config?.origin === 'endless' ? 'Chat' : undefined;
}

/** The thread's last result, when it is a Claude login failure in a Claude thread: it gets the login box. */
/**
 * The failed turn a sign-in fixes: the LAST result, when it is an error and the daemon said the
 * login is signed out (`authRequired`, any harness), or — for a Claude thread whose history has
 * no such event (older turns, REST pages) — its text reads like a login error.
 */
export function loginItemFor(type: string | undefined, items: ConvItem[], authRequired = false): ConvItem | null {
  if (type !== 'claude-code' && !authRequired) return null;
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k];
    if (it.kind !== 'result') continue;
    return it.isError && (authRequired || isClaudeAuthError(it.text ?? '')) ? it : null;
  }
  return null;
}

/**
 * The CLI's own login-error prose in the failed turn (Claude Code writes "Not logged in · Please
 * run /login" as a synthetic assistant message before the error result). With the signed-out card
 * shown, it is the same raw error twice, so it is left out. Only since the last turn that worked;
 * never the prose of a turn that succeeded.
 */
export function authProseToHide(items: ConvItem[], loginItem: ConvItem | null): Set<ConvItem> {
  const out = new Set<ConvItem>();
  if (!loginItem) return out;
  // From the end, not from the result: a REST page and the ws replay can order the turn's
  // synthetic prose after its result.
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k];
    // The run of failures since the last turn that WORKED (a REST page and the ws replay can put
    // a second copy of the user's message between the prose and the result).
    if (it.kind === 'result' && !it.isError) break;
    if (it.kind === 'assistant' && isClaudeAuthError(it.text ?? '') && (it.text ?? '').length < 300) out.add(it);
  }
  return out;
}

// The timeline walk and its leaf components live in ./timeline (W1-F). Re-exported here because
// the Control Plane timeline, Chat and the tests import them from this file.
export { renderTimeline, type TimelineExtensions, TaskNotice, MachineryBlock, ToolGroup, type ToolPair, UserBubble, AssistantText, Thinking, ResultFooter, StickToEndOnLoad, BootstrapOlderPages, LoadEarlierButton, LoadingOlderPill, JumpButton } from './timeline';
