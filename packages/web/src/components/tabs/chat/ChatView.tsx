import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { MessageScroller, useMessageScroller, useMessageScrollerScrollable } from '@shadcn/react/message-scroller';
import { PaperPlaneTilt, CaretDoubleDown, Sparkle, Brain, CaretRight, CheckCircle, WarningCircle, Paperclip, ArrowBendDownRight, Wrench, X } from '@phosphor-icons/react';
import type { ConvItem, PermissionQuestion } from '../../../api/types';
import { api, type ContentBlock } from '../../../api/client';
import { useStructuredChat } from './useStructuredChat';
import { useBootstrapOlderPages } from '../../../hooks/useBootstrapOlderPages';
import { AskQuestionCard, AnsweredQuestionCard } from './AskQuestionCard';
import { useTabs, findTerminal } from '../../../stores/tabs';
import { useDraft } from '../../../hooks/useDraft';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { useSettings, useDispatchName } from '../../../stores/settings';
import { useDictation } from '../../../hooks/useDictation';
import { DictationControl } from '../../dictation/DictationControl';
import { InputActionsMenu } from '../../dictation/InputActionsMenu';
import { InsightText } from '../../InsightText';
import { ResumeAdviceCard } from './ResumeAdviceCard';
import { WorkingIndicator, CompactingIndicator } from '../../WorkingIndicator';
import { Spinner } from '../../common/Spinner';
import { ChatImage } from '../../ChatImage';
import { ContextIndicator } from '../../ContextIndicator';
import { ToolCall, ToolResult } from '../ToolCall';
import { useUI } from '../../../stores/ui';
import { useToolGroupExpanded } from '../../../hooks/useToolUIState';

// Anthropic-vision-supported image types. Only these become a REAL base64 image block
// the model SEES; anything else (incl. SVG, which the model can't read) falls back to
// the path-reference line so the agent can still Read it from the inbox on disk.
const MODEL_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Base64-encode a File's bytes (chunked so a large image can't blow the call stack). */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * ChatView — the structured (stream-json) thread surface, built on shadcn's
 * MessageScroller chat primitive. Structured threads have no PTY, so this IS the
 * thread (no Terminal mode). Live events + optimistic user turns come from
 * useStructuredChat; tool calls are paired with their results by id.
 */
export function ChatView({ terminalId }: { terminalId: string }) {
  const tab = useTabs((s) => findTerminal(s.byProject, terminalId));
  const sessionId = tab?.sessionId;
  const { items, busy, model, send, pending, answer, contextTokens, compacting, compactResult, compact, hasMore, loadingOlder, loadOlder } = useStructuredChat(terminalId, sessionId);

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

  // Detect a loadOlder() prepend (items[0] changed, but the array isn't a full reset — the
  // PREVIOUS first item is still present somewhere later on) and remember that previous
  // first item as a permanent group boundary. Without this, renderTimeline's turn-grouping
  // (below) would silently MERGE the newly-prepended older content into whatever group used
  // to start the array — same top-level DOM node, just grown taller in place — which
  // MessageScroller's preserveScrollOnPrepend can't compensate for (it only recognizes a
  // prepend as NEW SIBLING nodes appearing before an unmoved existing one, not an existing
  // node silently growing). Forcing a flush at each boundary turns every older page into
  // its own new sibling group instead, matching what the scroller expects — see its use in
  // renderTimeline. Plain ref writes during render (no effect) — same pattern as `draftRef`
  // above, needed here because renderTimeline() below must see this render's boundary.
  const prevItemsRef = useRef<ConvItem[]>([]);
  const pageBoundariesRef = useRef<Set<ConvItem>>(new Set());
  if (items.length && prevItemsRef.current.length && items[0] !== prevItemsRef.current[0]) {
    pageBoundariesRef.current.add(prevItemsRef.current[0]);
  }
  prevItemsRef.current = items;

  const [draft, setDraft, clearDraft] = useDraft(terminalId);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Mirror the draft in a ref so the async upload loop appends to the latest value
  // (across awaits / multiple files) without clobbering what's already there.
  const draftRef = useRef(draft); draftRef.current = draft;
  const [uploadNote, setUploadNote] = useState('');
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

  function doSend() {
    const v = draft.trim();
    if (!v && stagedImages.length === 0) return;
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
    requestAnimationFrame(() => { if (taRef.current) taRef.current.style.height = 'auto'; });
  }

  // Upload each picked file to the project inbox. An IMAGE is then STAGED as a REAL base64
  // content block (see stagedImages) so it rides out with the user's next message as one
  // turn — and it echoes back + renders inline via the foundation's parser. A non-image keeps
  // the path-reference line in the draft so the user sends the path alongside their message
  // (the agent can Read it).
  async function attachFiles(files: FileList | null) {
    if (!files || !files.length || !sessionId) return;
    for (const f of Array.from(files)) {
      setUploadNote(`Uploading ${f.name}…`);
      try {
        const res = await api.uploadInbox(sessionId, f);
        if (MODEL_IMAGE_MIME.has(f.type)) {
          const data = await fileToBase64(f);
          const block: ContentBlock = { type: 'image', source: { type: 'base64', media_type: f.type, data } };
          setStagedImages((prev) => [...prev, block]);
          setUploadNote(`Attached ${f.name}`);
        } else {
          const cur = draftRef.current;
          const next = cur + (cur ? '\n' : '') + 'Attached file: ' + res.path;
          draftRef.current = next;
          setDraft(next);
          setUploadNote(`Attached ${f.name}`);
        }
      } catch {
        setUploadNote(`Upload failed: ${f.name}`);
      }
    }
    setTimeout(() => setUploadNote(''), 2500);
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
    const st = useTabs.getState();
    const existing = (st.byProject[sessionId] ?? []).find((t) => t.type === 'file' && (t.config?.path as string) === path);
    let id = existing?.id;
    if (!id) {
      try { const t = await api.createTerminal(sessionId, { type: 'file', label: path.split('/').pop() || path, config: { path } }); await st.loadTabs(sessionId); id = t.id; }
      catch { return; }
    }
    st.openTab(id);
    useUI.getState().requestOpenTab(id);
  }

  // Send is enabled by EITHER a non-empty draft OR at least one staged image (a screenshot
  // with no caption is a valid turn on its own).
  const canSend = draft.trim().length > 0 || stagedImages.length > 0;

  return (
    <div className="chat-scope" style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, background: 'var(--color-base)' }}>
      <MessageScroller.Provider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={48}>
        <MessageScroller.Root style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
          <MessageScroller.Viewport preserveScrollOnPrepend onScroll={onViewportScroll} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
            <MessageScroller.Content style={{ maxWidth: 768, margin: '0 auto', padding: '24px 20px 8px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              <LoadEarlierButton show={hasMore && !loadingOlder} onClick={loadOlder} />
              {items.length === 0 && !busy && !compacting && <EmptyState model={model} />}
              {renderTimeline(items, openFileInViewer, pageBoundariesRef.current)}
              {pending?.questions && pending.questions.length > 0 && (
                <MessageScroller.Item messageId="__ask" style={{ display: 'flex' }}>
                  {/* Interactive AskUserQuestion — answering unblocks the CLI (which is
                      parked on stdin). Keyed by requestId so a new question mounts fresh. */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <AskQuestionCard key={pending.requestId} questions={pending.questions} onAnswer={answer} />
                  </div>
                </MessageScroller.Item>
              )}
              {(busy || compacting) && (
                <MessageScroller.Item messageId="__working" style={{ display: 'flex' }}>
                  {/* Compaction wins the slot: it can coincide with busy (a message sent
                      mid-compaction sets busy too) but must never read as "Working…". */}
                  {compacting ? <CompactingIndicator /> : <WorkingIndicator />}
                </MessageScroller.Item>
              )}
            </MessageScroller.Content>
          </MessageScroller.Viewport>
          {/* Floating (NOT a Content child — see LoadingOlderPill's doc comment for why)
              "Loading earlier…" pill while a loadOlder() fetch is in flight. */}
          <LoadingOlderPill show={loadingOlder} />
          <JumpButton />
          <StickToEndOnLoad terminalId={terminalId} count={items.length} />
          <BootstrapOlderPages hasMore={hasMore} loadingOlder={loadingOlder} loadOlder={loadOlder} />
        </MessageScroller.Root>
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
              onFull={() => {
                setAdvice(null);
                // Remember per-thread, so switching away and back (in place — see the
                // dismissedFullIds doc comment above) doesn't bring the card back for THIS
                // resume. Not persisted: a later resume of the same thread should ask again.
                setDismissedFullIds((prev) => (prev.has(terminalId) ? prev : new Set(prev).add(terminalId)));
              }}
            />
          )}
        </div>
      )}

      {/* Composer (drop a file anywhere on it, or paste — routes through attachFiles) */}
      <div
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        style={{ flexShrink: 0, borderTop: '1px solid var(--color-border)', background: 'var(--color-pane)', padding: '10px 14px max(10px, env(safe-area-inset-bottom))' }}
      >
        {(dragActive || uploadNote) && (
          <div style={{ maxWidth: 768, margin: '0 auto 6px', fontSize: 12, color: dragActive ? 'var(--color-accent)' : 'var(--color-text-tertiary)' }}>
            {dragActive ? 'Drop image to attach' : uploadNote}
          </div>
        )}
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
        <div style={{ maxWidth: 768, margin: '0 auto', display: 'flex', alignItems: 'flex-end', gap: 8, background: dragActive ? 'color-mix(in srgb, var(--color-accent) 10%, var(--color-elevated))' : 'var(--color-elevated)', border: dragActive ? '1px solid var(--color-accent)' : '1px solid var(--color-border)', borderRadius: 12, padding: '8px 8px 8px 8px', transition: 'border-color .12s, background .12s' }}>
          {isMobile ? (
            <InputActionsMenu
              onAddFile={() => fileInputRef.current?.click()}
              onDictate={() => void dictation.start()}
              dictateDisabled={!sttConfigured}
              dictateHint="Set up in Settings → Transcription"
              triggerStyle={{ width: 34, height: 34, borderRadius: 9, border: 'none', background: 'var(--color-hover)' }}
            />
          ) : (
            <label
              title="Attach file"
              style={{ flexShrink: 0, width: 34, height: 34, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: 'var(--color-hover)', color: 'var(--color-text-secondary)' }}
            >
              <Paperclip size={17} />
              <input
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => { void attachFiles(e.target.files); e.currentTarget.value = ''; }}
              />
            </label>
          )}
          {/* hidden input the mobile + menu triggers (routes through the same attachFiles) */}
          <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { void attachFiles(e.target.files); e.currentTarget.value = ''; }} />
          {isMobile && dictation.state !== 'idle' ? (
            <DictationControl dictation={dictation} />
          ) : (
            <>
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); const el = e.target; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 180) + 'px'; }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } }}
            onPaste={onPaste}
            placeholder="Message…"
            rows={1}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            style={{ flex: 1, resize: 'none', border: 'none', outline: 'none', background: 'transparent', color: 'var(--color-text-primary)', font: '400 15px var(--font-sans)', lineHeight: 1.5, maxHeight: 180, overflowY: 'auto' }}
          />
          <button
            onClick={doSend}
            disabled={!canSend}
            title="Send"
            style={{ flexShrink: 0, width: 34, height: 34, borderRadius: 9, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: canSend ? 'pointer' : 'default', background: canSend ? 'var(--color-accent)' : 'var(--color-hover)', color: canSend ? '#06140B' : 'var(--color-text-tertiary)', transition: 'background .15s' }}
          >
            <PaperPlaneTilt size={17} weight="fill" />
          </button>
            </>
          )}
        </div>

        {/* thin status row: muted context-window fill indicator, tappable for detail */}
        <div style={{ maxWidth: 768, margin: '6px auto 0', display: 'flex', justifyContent: 'flex-end' }}>
          <ContextIndicator contextTokens={contextTokens} compacting={compacting} compactResult={compactResult} model={model} compact={compact} />
        </div>
      </div>
    </div>
  );
}

// Stable fallback id for a ConvItem that has neither `uuid` nor `toolId` (e.g. a plain
// 'user'/'assistant'/'result' item built by useStructuredChat's non-streaming reconcile
// path). Keyed by OBJECT IDENTITY, not array index: an item's index shifts every time
// loadOlder() prepends an older page in FRONT of it, and an index-derived key would force
// React to unmount+remount that node on every page — breaking MessageScroller's
// preserveScrollOnPrepend, which tracks the reader's scroll anchor by DOM node identity.
// Item objects themselves are never mutated in place after creation (the streaming reveal
// path only rewrites items that already carry a real uuid), so a WeakMap-cached id stays
// attached to the same logical item for its whole life in `items`.
let fallbackIdCounter = 0;
const fallbackIds = new WeakMap<ConvItem, string>();
function stableId(it: ConvItem): string {
  if (it.uuid) return it.uuid;
  if (it.toolId) return it.toolId;
  let id = fallbackIds.get(it);
  if (!id) { id = `fallback-${++fallbackIdCounter}`; fallbackIds.set(it, id); }
  return id;
}

/** A staged (pre-send) image preview with an × to drop it before sending. Mirrors the
 *  coordinator Composer's StagedThumbnail (packages/web/src/components/overseer/components/Composer.tsx). */
function StagedThumbnail({ src, onRemove }: { src: string; onRemove: () => void }) {
  return (
    <div style={{ position: 'relative', width: 48, height: 48, flex: 'none' }}>
      <img src={src} alt="attachment" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 8, border: '1px solid var(--color-border)', display: 'block' }} />
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

/**
 * Walk the timeline, pairing each tool with its result by id (parallel-safe) and
 * grouping each assistant turn into ONE row: a flush-left column holding that
 * turn's text / thinking / tool cards / footer. A `user` turn breaks the group
 * and renders its own right-aligned bubble. `pageBoundaries` (see ChatView's doc
 * comment on pageBoundariesRef) also forces a break — otherwise a loadOlder() prepend
 * could silently merge into a group that already existed, defeating scroll preservation.
 */
export function renderTimeline(items: ConvItem[], onViewFile: (p: string) => void, pageBoundaries: Set<ConvItem>) {
  // Map tool_use id -> its result item, so paired results aren't rendered standalone.
  const resultById = new Map<string, ConvItem>();
  // Set of tool ids that actually have a tool card, so an ORPHAN result (whose tool
  // was trimmed from the replay ring / arrived out of order) is still rendered
  // standalone instead of being silently dropped.
  const toolIds = new Set<string>();
  // Results already folded into a tool row by ADJACENCY pairing (the id-less shape). Filled
  // during the walk below — a result is always reached after the tool that claimed it.
  const consumed = new Set<ConvItem>();
  for (const it of items) {
    if (it.kind === 'tool-result' && it.toolId) resultById.set(it.toolId, it);
    if (it.kind === 'tool' && it.toolId) toolIds.add(it.toolId);
  }

  const rows: React.ReactNode[] = [];
  let group: { key: string; nodes: React.ReactNode[] } | null = null;
  const flushGroup = () => {
    if (group && group.nodes.length > 0) {
      rows.push(
        <MessageScroller.Item key={group.key} messageId={group.key} style={{ display: 'flex' }}>
          <AssistantTurn>{group.nodes}</AssistantTurn>
        </MessageScroller.Item>,
      );
    }
    group = null;
  };

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const id = stableId(it);

    if (pageBoundaries.has(it)) flushGroup();

    if (it.kind === 'user') {
      flushGroup();
      rows.push(
        <MessageScroller.Item key={id} messageId={id} style={{ display: 'flex', flexDirection: 'column' }}>
          <UserBubble text={it.text ?? ''} source={it.source} />
        </MessageScroller.Item>,
      );
      continue;
    }

    // Look ahead for a run of consecutive same-tool calls (ignoring their interleaved
    // results, which are rendered paired). A run of 2+ collapses into one ToolGroup.
    // AskUserQuestion is excluded — it has live-overlay special-casing below.
    if (it.kind === 'tool' && it.toolName !== 'AskUserQuestion') {
      const run: ConvItem[] = [it];
      // Tool-result items encountered while scanning the run, IN ENCOUNTER ORDER — used
      // below for en-bloc pairing of toolId-less members (see the `pairs` comment). Not
      // re-derived via items.indexOf() below, so advancing `i` past the run afterward is
      // an O(1) lookup — items.indexOf(run[run.length - 1]) would be an O(n) scan per
      // group (O(n^2) per render), and if `items` ever held a duplicated object reference
      // it could return an EARLIER index, moving `i` backwards into an infinite render loop.
      const runResults: ConvItem[] = [];
      let lastIdx = i;
      for (let j = i + 1; j < items.length; j++) {
        const nxt = items[j];
        if (pageBoundaries.has(nxt)) break;                    // boundary wins over everything
        if (nxt.kind === 'tool-result') {
          // A paired result is transparent to the run. An ORPHAN result (its tool_use fell
          // outside the replay window) renders standalone, so it must not be swallowed by
          // the run's index jump below — end the run before it instead. A toolId-less
          // result (older REST-paged history has no ids at all) has nothing to check
          // against, so it stays transparent here and is paired en bloc (below) when the
          // run's pairs are resolved.
          if (nxt.toolId && !toolIds.has(nxt.toolId)) break;
          runResults.push(nxt);
          lastIdx = j;
          continue;
        }
        if (nxt.kind !== 'tool' || nxt.toolName !== it.toolName) break;
        run.push(nxt);
        lastIdx = j;
      }
      if (run.length > 1) {
        // Resolve each run member's result ONCE: by toolId via `resultById` when it has
        // one (position-independent — correct for both the sequential [T,R,T,R] shape AND
        // the batched [T,T,R,R] shape Claude Code actually emits for parallel same-tool
        // calls: every tool_use block lands in ONE assistant message, all tool_results in
        // the NEXT user message). A toolId-less member (older REST-paged history has no
        // ids at all) has nothing to match by id, so it's paired EN BLOC instead: the k-th
        // toolId-less run member gets the k-th toolId-less result encountered during the
        // scan above — plain items[idx+1] adjacency would wrongly leave every result
        // orphaned except the run's last (all the results trail after both tool_uses in
        // the batched shape), permanently stuck on "running…" with a dead collapse button.
        let toolIdLessSeen = 0;
        const pairs = run.map((t) => ({
          tool: t,
          result: t.toolId ? resultById.get(t.toolId) : runResults[toolIdLessSeen++],
        }));
        const groupNode = <ToolGroup pairs={pairs} onViewFile={onViewFile} />;
        const lastId = stableId(run[run.length - 1]);
        if (!group) group = { key: lastId, nodes: [] };
        group.key = lastId;
        group.nodes.push(<div key={lastId}>{groupNode}</div>);
        // Skip past the run's members; their paired results are skipped by the
        // existing `toolIds.has(...)` guard on the 'tool-result' branch.
        i = lastIdx;
        continue;
      }
    }

    let node: React.ReactNode = null;
    if (it.kind === 'assistant') node = <AssistantText text={it.text ?? ''} />;
    else if (it.kind === 'image') node = <ChatImage src={it.imageUrl ?? ''} alt={it.imageAlt} />;
    else if (it.kind === 'thinking') node = <Thinking text={it.text ?? ''} />;
    else if (it.kind === 'tool') {
      const result = it.toolId ? resultById.get(it.toolId) : items[i + 1]?.kind === 'tool-result' ? items[i + 1] : undefined;
      // A result paired by ADJACENCY (neither side has a toolId — the shape REST-paged
      // history always has, since conversation/transcript.ts emits no ids at all) must be
      // marked consumed here. The `toolIds.has(...)` guard on the 'tool-result' branch below
      // can only recognize an id-based pairing, so without this the very same output rendered
      // twice on every REST-paged tool call: once folded into the tool row's "N lines", then
      // again as a stray "Output · N lines" row directly beneath it.
      if (result && !it.toolId) consumed.add(result);
      if (it.toolName === 'AskUserQuestion') {
        // While still pending (no tool_result yet) the interactive <AskQuestionCard> below
        // (the live overlay) covers it — node stays null and this item renders nothing here,
        // same as before. Once answered, its tool_result is a REAL, durable part of the
        // transcript (same as any other tool call) — render the collapsed record instead of
        // dropping it forever (the previous behavior: this whole branch used to `continue`
        // unconditionally, which is why an answered question vanished with no trace).
        if (result) {
          let questions: PermissionQuestion[] = [];
          try { questions = JSON.parse(it.toolInput ?? '{}')?.questions ?? []; } catch { /* malformed */ }
          if (questions.length) node = <AnsweredQuestionCard questions={questions} resultText={result.text ?? ''} />;
        }
      } else {
        node = <ToolCall tool={it} result={result} onViewFile={onViewFile} />;
      }
    } else if (it.kind === 'tool-result') {
      if (it.toolId && toolIds.has(it.toolId)) continue; // already shown paired with its tool
      if (consumed.has(it)) continue;                    // ...or paired by adjacency, above
      node = <ToolResult item={it} />;
    } else if (it.kind === 'result') node = <ResultFooter item={it} />;
    // A system-injected event (background-task completion) that arrived as a `user`-role
    // turn. Deliberately does NOT flushGroup() the way a real `user` turn does: it isn't a
    // new speaker, it's an interruption inside the assistant's own turn — the assistant
    // usually acts on it in the very next block, so breaking the column there would split
    // one continuous turn into two.
    else if (it.kind === 'notice') node = <TaskNotice text={it.text ?? ''} />;
    if (node == null) continue;

    if (!group) group = { key: id, nodes: [] };
    // Anchor the group's React key to its LAST item, re-set on every push (not just at
    // creation). A group's start can move earlier when loadOlder() prepends older history
    // that merges into it (no `user` boundary between them) — keying by the first item would
    // then change the key every time, forcing React to unmount+remount the node and breaking
    // MessageScroller's preserveScrollOnPrepend (it tracks anchor position by DOM node
    // identity). The group's LAST item is untouched by anything prepended before it, so
    // keying there keeps the node — and the reader's scroll position — stable across a page.
    group.key = id;
    group.nodes.push(<div key={id}>{node}</div>);
  }
  flushGroup();
  return rows;
}

/**
 * A system-injected background-task completion (see lib/taskNotification.ts). Styled to
 * read as machine bookkeeping, not speech: muted, small, flush-left, at the same indent as
 * a tool row — which is what it is, structurally, the tail of a backgrounded tool call.
 * Only the CLI's own <summary> line is shown; the surrounding XML (task-id, tool-use-id,
 * output-file) is bookkeeping the reader has no use for.
 */
export function TaskNotice({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 6px', minWidth: 0 }}>
      <CheckCircle size={13} weight="bold" color="var(--color-text-tertiary)" style={{ flexShrink: 0 }} />
      <span style={{ minWidth: 0, fontSize: 11.5, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={text}>
        {text}
      </span>
    </div>
  );
}

/** One assistant turn: a flush-left flex-column holding all its blocks. */
function AssistantTurn({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {children}
    </div>
  );
}

/** One run member paired with its already-resolved result (by toolId, or en bloc by
 * position — see renderTimeline's `pairs` construction), so ToolGroup never has to
 * re-derive pairing. */
type ToolPair = { tool: ConvItem; result?: ConvItem };

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
function ToolGroup({ pairs, onViewFile }: { pairs: ToolPair[]; onViewFile: (p: string) => void }) {
  const firstId = pairs[0].tool.toolId ?? pairs[0].tool.uuid;
  const running = pairs.some((p) => !p.result);
  const [manualOpen, setManualOpen] = useToolGroupExpanded(firstId ? `group:${firstId}` : undefined, undefined);
  const expanded = manualOpen === undefined ? running : manualOpen;
  const toolName = pairs[0].tool.toolName;
  const label = `${toolName} ${pairs.length} calls`;
  // "Read 3 files" reads better than "Read 3 calls" for the file-shaped tools.
  const fileish = toolName === 'Read' || toolName === 'Write' || toolName === 'Edit';
  const heading = fileish ? `${toolName} ${pairs.length} files` : label;
  const lines = pairs.reduce((n, p) => n + (p.result?.text?.split('\n').length ?? 0), 0);

  if (expanded) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <GroupHeader heading={heading} lines={lines} running={running} open onClick={() => setManualOpen(false)} />
        <div style={{ paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {pairs.map(({ tool: t, result }) => (
            <ToolCall key={stableId(t)} tool={t} result={result} onViewFile={onViewFile} />
          ))}
        </div>
      </div>
    );
  }
  return <GroupHeader heading={heading} lines={lines} running={running} open={false} onClick={() => setManualOpen(true)} />;
}

function GroupHeader({ heading, lines, running, open, onClick }: { heading: string; lines: number; running: boolean; open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onClick}
      style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: 7, display: 'flex', gap: 7, alignItems: 'center' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-hover)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
    >
      <CaretRight size={11} weight="bold" style={{ flexShrink: 0, color: 'var(--color-text-tertiary)', transition: 'transform .12s ease', transform: open ? 'rotate(90deg)' : 'none' }} />
      <Wrench size={13} color="#5A8DD6" style={{ flexShrink: 0 }} />
      <span style={{ minWidth: 0, flex: 1, fontSize: 12.5, color: 'var(--color-text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{heading}</span>
      {running
        ? <span className="chat-shimmer" style={{ flexShrink: 0, fontSize: 11 }}>running…</span>
        : <span style={{ flexShrink: 0, fontSize: 11, color: 'var(--color-text-secondary)' }}>{lines} line{lines !== 1 ? 's' : ''}</span>}
    </button>
  );
}

function EmptyState({ model }: { model?: string }) {
  return (
    <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13.5, textAlign: 'center', padding: '48px 0' }}>
      <Sparkle size={28} weight="duotone" color="var(--color-accent)" style={{ marginBottom: 10 }} />
      <div style={{ color: 'var(--color-text-secondary)' }}>Send a message to start the conversation.</div>
      {model && <div style={{ marginTop: 6, fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{model}</div>}
    </div>
  );
}

// A 'user'-role turn the coordinator sent on the human's behalf (spawn_agent / message_agent)
// still needs its own right-aligned slot in the timeline (it's structurally a user turn), but
// reading it as "sent by the human" would be misleading — so it gets a small "via {Dispatch
// name}" label (same ArrowBendDownRight "relayed" icon the coordinator's own Stream uses for
// injected notices) and a muted/bordered bubble instead of the bright human-accent one.
// `source === 'user'` or undefined (untagged/legacy) renders exactly like before.
export function UserBubble({ text, source }: { text: string; source?: 'user' | 'coordinator' }) {
  const dispatchName = useDispatchName();
  const viaCoordinator = source === 'coordinator';
  return (
    <div style={{ alignSelf: 'flex-end', maxWidth: '85%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      {viaCoordinator && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: 'var(--color-accent)' }}>
          <ArrowBendDownRight size={12} weight="bold" />
          via {dispatchName}
        </div>
      )}
      <div
        style={{
          background: viaCoordinator ? 'var(--color-elevated)' : 'var(--color-accent)',
          border: viaCoordinator ? '1px solid var(--color-border)' : 'none',
          color: viaCoordinator ? 'var(--color-text-primary)' : '#06140B',
          borderRadius: '14px 14px 4px 14px',
          padding: '9px 13px',
          font: '400 15px var(--font-sans)',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {text}
      </div>
    </div>
  );
}

// Assistant prose flows through the SHARED <InsightText> so ★ Insight blocks become tinted
// callouts here identically to the coordinator stream (scheme="global" → app --color-* tokens).
function AssistantText({ text }: { text: string }) {
  if (!text) return null;
  return <InsightText source={text} scheme="global" />;
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', font: 'italic 400 12.5px var(--font-sans)', padding: 0 }}>
        <CaretRight size={11} weight="bold" style={{ transition: 'transform .12s', transform: open ? 'rotate(90deg)' : 'none' }} />
        <Brain size={13} weight="duotone" /> Thinking
      </button>
      {open && (
        <div style={{ marginTop: 5, paddingLeft: 12, borderLeft: '2px solid var(--color-border)', color: 'var(--color-text-secondary)', font: 'italic 400 13px var(--font-sans)', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {text}
        </div>
      )}
    </div>
  );
}

function ResultFooter({ item }: { item: ConvItem }) {
  const parts: string[] = [];
  if (typeof item.costUsd === 'number') parts.push(`$${item.costUsd.toFixed(item.costUsd < 0.01 ? 4 : 2)}`);
  const tok = (item.tokensIn ?? 0) + (item.tokensOut ?? 0);
  if (tok > 0) parts.push(`${tok.toLocaleString()} tok`);
  if (item.durationMs) parts.push(`${(item.durationMs / 1000).toFixed(1)}s`);
  if (item.turns) parts.push(`${item.turns} turn${item.turns !== 1 ? 's' : ''}`);
  if (item.isError) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-status-red)', font: '400 12px var(--font-sans)' }}>
        <WarningCircle size={14} weight="fill" /> {item.text || 'Turn ended with an error'}
        {parts.length > 0 && <span style={{ opacity: 0.7 }}> · {parts.join(' · ')}</span>}
      </div>
    );
  }
  if (parts.length === 0) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-secondary)', font: '400 11.5px var(--font-mono)' }}>
      <CheckCircle size={13} weight="fill" color="var(--color-accent)" /> {parts.join(' · ')}
    </div>
  );
}

/**
 * Render-nothing helper: keep a freshly-opened (or freshly-switched) thread pinned to
 * the bottom through its post-mount backfill burst. shadcn's autoScroll follows LIVE
 * deltas while the user is pinned, but the initial replay arrives as a rapid append
 * burst that can strand the viewport above the fold (a content change can flip the
 * scroller out of "following-bottom" before it catches up). We force scrollToEnd('auto')
 * — instant, never smooth — on each append while still engaged, then hand off to native
 * autoScroll the moment the user scrolls off-tail. Crucially this runs in a LAYOUT effect
 * (pre-paint): the stick lands before the browser paints each backfill frame, so the thread
 * opens ALREADY at the bottom instead of visibly scrolling top→bottom through its history.
 */
function StickToEndOnLoad({ terminalId, count }: { terminalId: string; count: number }) {
  const { scrollToEnd } = useMessageScroller();
  const { end } = useMessageScrollerScrollable(); // end === true ⇒ off-tail (content below the fold)
  const settledRef = useRef(false);
  const prevCountRef = useRef(-1);
  const termRef = useRef(terminalId);

  useLayoutEffect(() => {
    // New thread → re-arm so its own backfill re-sticks to the bottom.
    if (termRef.current !== terminalId) {
      termRef.current = terminalId;
      settledRef.current = false;
      prevCountRef.current = -1;
    }
    // `items` only ever GROWS or RESETS-TO-EMPTY (useStructuredChat appends or setItems([])),
    // so a count regression unambiguously means the list was cleared/replaced — a ws-reconnect
    // `onReset` replay (same terminalId) or a non-keyed remount whose outgoing-thread count
    // (e.g. 50) still sits in prevCountRef while the new backfill climbs 0→N<50. Re-arm so the
    // append burst exceeds prevCount and re-sticks. (Handles tab-switch + reconnect + replay.)
    if (count < prevCountRef.current) prevCountRef.current = -1;
    if (settledRef.current) return;
    if (count > prevCountRef.current) {
      // Backfill / live append while still engaged → snap to the bottom. We scroll even
      // when `end` reads off-tail: during the burst the viewport legitimately starts above
      // the fold and must be pulled down. (Right after our own scroll `end` reads stale-true
      // for a frame — but that frame is a count-GROWTH tick, handled here, never below.)
      prevCountRef.current = count;
      scrollToEnd({ behavior: 'auto' });
      return;
    }
    // Count held steady AND we're parked off-tail → the user scrolled up themselves.
    // Disengage for the rest of this thread; native autoScroll owns follow-while-pinned now.
    if (end) settledRef.current = true;
  }, [terminalId, count, end, scrollToEnd]);

  return null;
}

/**
 * Render-nothing helper: pages in older history right after mount/thread-switch/reconnect
 * when the initial content is too short to overflow the viewport — otherwise the reader has
 * nothing to scroll and onViewportScroll's near-top trigger never fires, stranding `hasMore:
 * true` history that's unreachable through the UI. See useBootstrapOlderPages's doc comment.
 */
function BootstrapOlderPages(props: { hasMore: boolean; loadingOlder: boolean; loadOlder: () => void }) {
  useBootstrapOlderPages(props);
  return null;
}

/**
 * Explicit "Load earlier messages" control, rendered as the FIRST child of
 * MessageScroller.Content (above the timeline). Paging older history otherwise depends
 * entirely on the reader being able to SCROLL — onViewportScroll's near-top trigger, or
 * useBootstrapOlderPages' overflow check — which strands history whenever the current
 * window is short enough not to overflow (in the limit: nothing rendered at all, so there
 * is nothing to scroll). A tappable control makes older history reachable unconditionally,
 * on desktop and mobile alike. Hidden while a fetch is in flight — the floating
 * <LoadingOlderPill/> owns that state.
 */
export function LoadEarlierButton({ show, onClick }: { show: boolean; onClick: () => void }) {
  if (!show) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        alignSelf: 'center',
        font: '500 12px var(--font-sans)',
        color: 'var(--color-text-secondary)',
        background: 'var(--color-elevated)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        padding: '5px 12px',
        cursor: 'pointer',
      }}
    >
      Load earlier messages
    </button>
  );
}

/**
 * Floating "Loading earlier…" pill shown while loadOlder() is in flight. Deliberately
 * rendered as a sibling of MessageScroller.Viewport (absolutely positioned over it), NOT
 * as a Content child: the vendored scroller's preserveScrollOnPrepend keeps the reader's
 * position by diffing Content's actual children across a mutation, and toggling a node
 * in and out of that list right alongside the real prepend (both land in the same React
 * commit) can race that diff. Floating it outside Content sidesteps that entirely.
 */
function LoadingOlderPill({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 20, background: 'var(--color-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-text-tertiary)', fontSize: 11.5, zIndex: 5, pointerEvents: 'none' }}>
      <Spinner size={11} /> Loading earlier…
    </div>
  );
}

/** shadcn MessageScroller.Button — floating "jump to latest", shown only off-tail. */
function JumpButton() {
  const { end } = useMessageScrollerScrollable();
  if (!end) return null;
  return (
    <MessageScroller.Button
      direction="end"
      style={{ position: 'absolute', right: 16, bottom: 16, width: 40, height: 40, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-accent)', color: '#06140B', border: 'none', boxShadow: '0 8px 22px -6px rgba(0,0,0,.7)', cursor: 'pointer', zIndex: 5 }}
    >
      <CaretDoubleDown size={18} weight="bold" />
    </MessageScroller.Button>
  );
}
