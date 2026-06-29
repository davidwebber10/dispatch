import { useRef, useState } from 'react';
import { MessageScroller, useMessageScrollerScrollable } from '@shadcn/react/message-scroller';
import { PaperPlaneTilt, CaretDoubleDown, Sparkle, Brain, CaretRight, CheckCircle, WarningCircle, Paperclip } from '@phosphor-icons/react';
import type { ConvItem } from '../../../api/types';
import { api } from '../../../api/client';
import { useStructuredChat } from './useStructuredChat';
import { useTabs, findTerminal } from '../../../stores/tabs';
import { useDraft } from '../../../hooks/useDraft';
import { renderMarkdown } from '../../../lib/markdown';
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
  const { items, busy, model, send } = useStructuredChat(terminalId);

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

/** Walk the timeline, pairing each tool with its result by id (parallel-safe). */
function renderTimeline(items: ConvItem[], onViewFile: (p: string) => void) {
  // Map tool_use id -> its result item, so paired results aren't rendered standalone.
  const resultById = new Map<string, ConvItem>();
  for (const it of items) if (it.kind === 'tool-result' && it.toolId) resultById.set(it.toolId, it);

  const rows: React.ReactNode[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    let node: React.ReactNode = null;
    let anchor = false;
    if (it.kind === 'user') { node = <UserBubble text={it.text ?? ''} />; anchor = true; }
    else if (it.kind === 'assistant') node = <AssistantText text={it.text ?? ''} />;
    else if (it.kind === 'thinking') node = <Thinking text={it.text ?? ''} />;
    else if (it.kind === 'tool') {
      const result = it.toolId ? resultById.get(it.toolId) : items[i + 1]?.kind === 'tool-result' ? items[i + 1] : undefined;
      node = <ToolCall tool={it} result={result} onViewFile={onViewFile} />;
    } else if (it.kind === 'tool-result') {
      if (it.toolId && resultById.has(it.toolId)) continue; // already shown paired with its tool
      node = <ToolResult item={it} />;
    } else if (it.kind === 'result') node = <ResultFooter item={it} />;
    if (node == null) continue;
    rows.push(
      <MessageScroller.Item key={i} messageId={String(i)} scrollAnchor={anchor} style={{ display: 'flex', flexDirection: 'column' }}>
        {node}
      </MessageScroller.Item>,
    );
  }
  return rows;
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
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <div style={{ flexShrink: 0, width: 24, height: 24, borderRadius: 7, background: 'var(--color-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
        <Sparkle size={14} weight="fill" color="var(--color-accent)" />
      </div>
      <div className="md-view" style={{ flex: 1, minWidth: 0 }} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <div style={{ marginLeft: 34 }}>
      <button onClick={() => setOpen((o) => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', font: 'italic 400 12.5px var(--font-sans)', padding: 0 }}>
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
      <div style={{ marginLeft: 34, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-status-red)', font: '400 12px var(--font-sans)' }}>
        <WarningCircle size={14} weight="fill" /> {item.text || 'Turn ended with an error'}
        {parts.length > 0 && <span style={{ opacity: 0.7 }}> · {parts.join(' · ')}</span>}
      </div>
    );
  }
  if (parts.length === 0) return null;
  return (
    <div style={{ marginLeft: 34, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-tertiary)', font: '400 11.5px var(--font-mono)' }}>
      <CheckCircle size={13} weight="fill" color="var(--color-accent)" /> {parts.join(' · ')}
    </div>
  );
}

function WorkingIndicator() {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <div style={{ flexShrink: 0, width: 24, height: 24, borderRadius: 7, background: 'var(--color-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Sparkle size={14} weight="fill" color="var(--color-accent)" className="dispatch-wiggle" />
      </div>
      <span className="chat-shimmer" style={{ font: '500 13.5px var(--font-sans)' }}>Working…</span>
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
