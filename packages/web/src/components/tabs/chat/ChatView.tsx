import { useEffect, useRef, useState } from 'react';
import { MessageScroller, useMessageScroller, useMessageScrollerScrollable } from '@shadcn/react/message-scroller';
import { PaperPlaneTilt, CaretDoubleDown, Sparkle, Brain, CaretRight, CheckCircle, WarningCircle, Paperclip } from '@phosphor-icons/react';
import type { ConvItem } from '../../../api/types';
import { api } from '../../../api/client';
import { useStructuredChat } from './useStructuredChat';
import { useTabs, findTerminal } from '../../../stores/tabs';
import { useDraft } from '../../../hooks/useDraft';
import { Markdown } from '../../Markdown';
import { WorkingIndicator } from '../../WorkingIndicator';
import { ChatImage } from '../../ChatImage';
import { ToolCall, ToolResult } from '../ToolCall';
import { useUI } from '../../../stores/ui';

/**
 * ChatView — the structured (stream-json) thread surface, built on shadcn's
 * MessageScroller chat primitive. Structured threads have no PTY, so this IS the
 * thread (no Terminal mode). Live events + optimistic user turns come from
 * useStructuredChat; tool calls are paired with their results by id.
 */
export function ChatView({ terminalId }: { terminalId: string }) {
  const tab = useTabs((s) => findTerminal(s.byProject, terminalId));
  const sessionId = tab?.sessionId;
  const { items, busy, model, send } = useStructuredChat(terminalId, sessionId);

  const [draft, setDraft, clearDraft] = useDraft(terminalId);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Mirror the draft in a ref so the async upload loop appends to the latest value
  // (across awaits / multiple files) without clobbering what's already there.
  const draftRef = useRef(draft); draftRef.current = draft;
  const [uploadNote, setUploadNote] = useState('');

  function doSend() {
    const v = draft.trim();
    if (!v) return;
    send(v);
    clearDraft();
    requestAnimationFrame(() => { if (taRef.current) taRef.current.style.height = 'auto'; });
  }

  // Upload each picked file to the project inbox and append a reference line to the
  // draft so the user sends the path alongside their message (the agent can Read it).
  async function attachFiles(files: FileList | null) {
    if (!files || !files.length || !sessionId) return;
    for (const f of Array.from(files)) {
      setUploadNote(`Uploading ${f.name}…`);
      try {
        const res = await api.uploadInbox(sessionId, f);
        const cur = draftRef.current;
        const next = cur + (cur ? '\n' : '') + 'Attached file: ' + res.path;
        draftRef.current = next;
        setDraft(next);
        setUploadNote(`Attached ${f.name}`);
      } catch {
        setUploadNote(`Upload failed: ${f.name}`);
      }
    }
    setTimeout(() => setUploadNote(''), 2500);
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
          <MessageScroller.Viewport preserveScrollOnPrepend style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
            <MessageScroller.Content style={{ maxWidth: 768, margin: '0 auto', padding: '24px 20px 8px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              {items.length === 0 && !busy && <EmptyState model={model} />}
              {renderTimeline(items, openFileInViewer)}
              {busy && (
                <MessageScroller.Item messageId="__working" style={{ display: 'flex' }}>
                  <WorkingIndicator />
                </MessageScroller.Item>
              )}
            </MessageScroller.Content>
          </MessageScroller.Viewport>
          <JumpButton />
          <StickToEndOnLoad terminalId={terminalId} count={items.length} />
        </MessageScroller.Root>
      </MessageScroller.Provider>

      {/* Composer */}
      <div style={{ flexShrink: 0, borderTop: '1px solid var(--color-border)', background: 'var(--color-pane)', padding: '10px 14px max(10px, env(safe-area-inset-bottom))' }}>
        {uploadNote && (
          <div style={{ maxWidth: 768, margin: '0 auto 6px', fontSize: 12, color: 'var(--color-text-tertiary)' }}>{uploadNote}</div>
        )}
        <div style={{ maxWidth: 768, margin: '0 auto', display: 'flex', alignItems: 'flex-end', gap: 8, background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 12, padding: '8px 8px 8px 8px' }}>
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
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); const el = e.target; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 180) + 'px'; }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } }}
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
        </div>
      </div>
    </div>
  );
}

/**
 * Walk the timeline, pairing each tool with its result by id (parallel-safe) and
 * grouping each assistant turn into ONE row: a single Sparkle avatar + a shared
 * left gutter holding that turn's text / thinking / tool cards / footer. A `user`
 * turn breaks the group and renders its own right-aligned bubble.
 */
function renderTimeline(items: ConvItem[], onViewFile: (p: string) => void) {
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
    const id = it.uuid ?? it.toolId ?? `${it.kind}-${i}`;

    if (it.kind === 'user') {
      flushGroup();
      rows.push(
        <MessageScroller.Item key={id} messageId={id} style={{ display: 'flex', flexDirection: 'column' }}>
          <UserBubble text={it.text ?? ''} />
        </MessageScroller.Item>,
      );
      continue;
    }

    let node: React.ReactNode = null;
    if (it.kind === 'assistant') node = <AssistantText text={it.text ?? ''} />;
    else if (it.kind === 'image') node = <ChatImage src={it.imageUrl ?? ''} alt={it.imageAlt} />;
    else if (it.kind === 'thinking') node = <Thinking text={it.text ?? ''} />;
    else if (it.kind === 'tool') {
      const result = it.toolId ? resultById.get(it.toolId) : items[i + 1]?.kind === 'tool-result' ? items[i + 1] : undefined;
      node = <ToolCall tool={it} result={result} onViewFile={onViewFile} />;
    } else if (it.kind === 'tool-result') {
      if (it.toolId && toolIds.has(it.toolId)) continue; // already shown paired with its tool
      node = <ToolResult item={it} />;
    } else if (it.kind === 'result') node = <ResultFooter item={it} />;
    if (node == null) continue;

    if (!group) group = { key: id, nodes: [] };
    group.nodes.push(<div key={id}>{node}</div>);
  }
  flushGroup();
  return rows;
}

/** One assistant turn: a single avatar + a flex-column gutter for all its blocks. */
function AssistantTurn({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <div style={{ flexShrink: 0, width: 24, height: 24, borderRadius: 7, background: 'var(--color-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
        <Sparkle size={14} weight="fill" color="var(--color-accent)" />
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {children}
      </div>
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

function UserBubble({ text }: { text: string }) {
  return (
    <div style={{ alignSelf: 'flex-end', maxWidth: '85%', background: 'var(--color-accent)', color: '#06140B', borderRadius: '14px 14px 4px 14px', padding: '9px 13px', font: '400 15px var(--font-sans)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {text}
    </div>
  );
}

function AssistantText({ text }: { text: string }) {
  if (!text) return null;
  // Avatar is rendered once per turn by AssistantTurn; this is just the prose.
  return <Markdown source={text} />;
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
 * — instant, so it never animates against the user — on each append while still engaged,
 * then hand off to native autoScroll the moment the user scrolls off-tail.
 */
function StickToEndOnLoad({ terminalId, count }: { terminalId: string; count: number }) {
  const { scrollToEnd } = useMessageScroller();
  const { end } = useMessageScrollerScrollable(); // end === true ⇒ off-tail (content below the fold)
  const settledRef = useRef(false);
  const prevCountRef = useRef(-1);
  const termRef = useRef(terminalId);

  useEffect(() => {
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
