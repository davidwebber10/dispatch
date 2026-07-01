import { useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { MessageScroller, useMessageScroller, useMessageScrollerScrollable } from '@shadcn/react/message-scroller';
import { PaperPlaneTilt, CaretDoubleDown, Sparkle, Brain, CaretRight, CheckCircle, WarningCircle, Paperclip, ArrowBendDownRight } from '@phosphor-icons/react';
import type { ConvItem } from '../../../api/types';
import { api, type ContentBlock } from '../../../api/client';
import { useStructuredChat } from './useStructuredChat';
import { AskQuestionCard } from './AskQuestionCard';
import { useTabs, findTerminal } from '../../../stores/tabs';
import { useDraft } from '../../../hooks/useDraft';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { useSettings, useDispatchName } from '../../../stores/settings';
import { useDictation } from '../../../hooks/useDictation';
import { DictationControl } from '../../dictation/DictationControl';
import { InputActionsMenu } from '../../dictation/InputActionsMenu';
import { InsightText } from '../../InsightText';
import { WorkingIndicator } from '../../WorkingIndicator';
import { Spinner } from '../../common/Spinner';
import { ChatImage } from '../../ChatImage';
import { ContextIndicator } from '../../ContextIndicator';
import { ToolCall, ToolResult } from '../ToolCall';
import { useUI } from '../../../stores/ui';

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
    if (!v) return;
    send(v);
    clearDraft();
    requestAnimationFrame(() => { if (taRef.current) taRef.current.style.height = 'auto'; });
  }

  // Upload each picked file to the project inbox. An IMAGE is then sent as a REAL base64
  // content block (its own turn) so the model SEES it — and it echoes back + renders
  // inline via the foundation's parser. A non-image keeps the path-reference line in the
  // draft so the user sends the path alongside their message (the agent can Read it).
  async function attachFiles(files: FileList | null) {
    if (!files || !files.length || !sessionId) return;
    for (const f of Array.from(files)) {
      setUploadNote(`Uploading ${f.name}…`);
      try {
        const res = await api.uploadInbox(sessionId, f);
        if (MODEL_IMAGE_MIME.has(f.type)) {
          const data = await fileToBase64(f);
          const block: ContentBlock = { type: 'image', source: { type: 'base64', media_type: f.type, data } };
          send([block]);
          setUploadNote(`Sent ${f.name}`);
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

  return (
    <div className="chat-scope" style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, background: 'var(--color-base)' }}>
      <MessageScroller.Provider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={48}>
        <MessageScroller.Root style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
          <MessageScroller.Viewport preserveScrollOnPrepend onScroll={onViewportScroll} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
            <MessageScroller.Content style={{ maxWidth: 768, margin: '0 auto', padding: '24px 20px 8px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              {items.length === 0 && !busy && <EmptyState model={model} />}
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
              {busy && (
                <MessageScroller.Item messageId="__working" style={{ display: 'flex' }}>
                  <WorkingIndicator />
                </MessageScroller.Item>
              )}
            </MessageScroller.Content>
          </MessageScroller.Viewport>
          {/* Floating (NOT a Content child — see LoadingOlderPill's doc comment for why)
              "Loading earlier…" pill while a loadOlder() fetch is in flight. */}
          <LoadingOlderPill show={loadingOlder} />
          <JumpButton />
          <StickToEndOnLoad terminalId={terminalId} count={items.length} />
        </MessageScroller.Root>
      </MessageScroller.Provider>

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
            disabled={!draft.trim()}
            title="Send"
            style={{ flexShrink: 0, width: 34, height: 34, borderRadius: 9, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: draft.trim() ? 'pointer' : 'default', background: draft.trim() ? 'var(--color-accent)' : 'var(--color-hover)', color: draft.trim() ? '#06140B' : 'var(--color-text-tertiary)', transition: 'background .15s' }}
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

/**
 * Walk the timeline, pairing each tool with its result by id (parallel-safe) and
 * grouping each assistant turn into ONE row: a flush-left column holding that
 * turn's text / thinking / tool cards / footer. A `user` turn breaks the group
 * and renders its own right-aligned bubble. `pageBoundaries` (see ChatView's doc
 * comment on pageBoundariesRef) also forces a break — otherwise a loadOlder() prepend
 * could silently merge into a group that already existed, defeating scroll preservation.
 */
function renderTimeline(items: ConvItem[], onViewFile: (p: string) => void, pageBoundaries: Set<ConvItem>) {
  // Map tool_use id -> its result item, so paired results aren't rendered standalone.
  const resultById = new Map<string, ConvItem>();
  // Set of tool ids that actually have a tool card, so an ORPHAN result (whose tool
  // was trimmed from the replay ring / arrived out of order) is still rendered
  // standalone instead of being silently dropped.
  const toolIds = new Set<string>();
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

    let node: React.ReactNode = null;
    if (it.kind === 'assistant') node = <AssistantText text={it.text ?? ''} />;
    else if (it.kind === 'image') node = <ChatImage src={it.imageUrl ?? ''} alt={it.imageAlt} />;
    else if (it.kind === 'thinking') node = <Thinking text={it.text ?? ''} />;
    else if (it.kind === 'tool') {
      // AskUserQuestion is rendered by the interactive <AskQuestionCard> (live) — never
      // as a generic tool card, which would sit stuck on "running…" (its tool_result only
      // arrives once answered). Its paired tool_result is already suppressed below.
      if (it.toolName === 'AskUserQuestion') continue;
      const result = it.toolId ? resultById.get(it.toolId) : items[i + 1]?.kind === 'tool-result' ? items[i + 1] : undefined;
      node = <ToolCall tool={it} result={result} onViewFile={onViewFile} />;
    } else if (it.kind === 'tool-result') {
      if (it.toolId && toolIds.has(it.toolId)) continue; // already shown paired with its tool
      node = <ToolResult item={it} />;
    } else if (it.kind === 'result') node = <ResultFooter item={it} />;
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

/** One assistant turn: a flush-left flex-column holding all its blocks. */
function AssistantTurn({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {children}
    </div>
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
function UserBubble({ text, source }: { text: string; source?: 'user' | 'coordinator' }) {
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
