import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type UIEvent } from 'react';
import { MessageScroller, useMessageScroller } from '@shadcn/react/message-scroller';
import { ArrowUp, Paperclip, X } from '@phosphor-icons/react';
import { useEndless } from '../../stores/endless';
import { useBootstrapOlderPages } from '../../hooks/useBootstrapOlderPages';
import { LoadEarlierButton, Thinking } from '../tabs/chat/ChatView';
import { InsightText } from '../InsightText';
import { WorkingIndicator } from '../WorkingIndicator';
import { EndlessRows, rowKeyOf } from './EndlessMessageRow';
import { ProjectSelect } from './ProjectSelect';
import type { EndlessImage } from '../../api/types';
import { MODEL_IMAGE_MIME, fileToBase64 } from '../../lib/image-attach';

/** Pages older history in while the first page is too short to scroll (see useBootstrapOlderPages). */
function BootstrapOlder() {
  const hasMore = useEndless((s) => s.hasMore);
  const loadingOlder = useEndless((s) => s.loadingOlder);
  const loadOlder = useEndless((s) => s.loadOlder);
  useBootstrapOlderPages({ hasMore, loadingOlder, loadOlder });
  return null;
}

/**
 * Scrolls to the search focus through the scroller. scrollToMessage puts the scroller in
 * its jump mode, so its own follow-the-end handlers do not pull the view back down after
 * the window swap (a plain scrollIntoView left it following the end). When the focus
 * returns to null ("Back to latest"), scrollToEnd resumes following.
 * It scrolls only when the focus changes: a later prepend or append must not move the reader.
 */
function FocusScroll() {
  const focus = useEndless((s) => s.focus);
  const messages = useEndless((s) => s.messages);
  const { scrollToMessage, scrollToEnd } = useMessageScroller();
  const scrolledFocus = useRef<number | null>(null);
  const prevFocus = useRef<number | null>(focus);
  useEffect(() => {
    const was = prevFocus.current;
    prevFocus.current = focus;
    if (focus === null) {
      scrolledFocus.current = null;
      if (was !== null) scrollToEnd({ behavior: 'auto' });
      return;
    }
    if (scrolledFocus.current === focus) return;
    const key = rowKeyOf(messages, focus);
    if (key === null) return;
    scrolledFocus.current = focus;
    scrollToMessage(`m${key}`, { align: 'center' });
  }, [focus, messages, scrollToMessage, scrollToEnd]);
  return null;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function TurnError({ text, mobile = false }: { text: string; mobile?: boolean }) {
  return (
    <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: mobile ? '10px 16px' : '10px 12px', border: '1px solid var(--color-status-red)', borderRadius: 8, color: 'var(--color-text-primary)', fontSize: 13.5 }}>
      <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{text}</span>
      <button type="button" onClick={() => void useEndless.getState().retry()} style={{ flexShrink: 0, padding: '5px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', cursor: 'pointer' }}>Retry</button>
    </div>
  );
}

const iconBtn: React.CSSProperties = { width: 36, height: 36, padding: 0, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10, border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-secondary)', cursor: 'pointer' };

export function Composer({ mobile = false }: { mobile?: boolean } = {}) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<EndlessImage[]>([]);
  const filter = useEndless((s) => s.filter);
  const [project, setProject] = useState<string | null>(filter);
  useEffect(() => setProject(filter), [filter]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const sending = useRef(false);

  // Clear the draft only after the send succeeds; a failed send keeps it and shows why.
  const submit = async () => {
    const raw = text;
    const t = raw.trim();
    if ((!t && images.length === 0) || sending.current) return;
    const imgs = images;
    sending.current = true;
    setSendError(null);
    try {
      await useEndless.getState().send(t, project, imgs);
      setText((cur) => (cur === raw ? '' : cur));
      setImages((cur) => (cur === imgs ? [] : cur));
    } catch (err) {
      setSendError(`Send failed: ${errorText(err)}`);
    } finally {
      sending.current = false;
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
  };
  const onFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])].filter((f) => MODEL_IMAGE_MIME.has(f.type));
    const add = await Promise.all(files.map(async (f) => ({ media_type: f.type, data: await fileToBase64(f) })));
    setImages((prev) => [...prev, ...add]);
    e.target.value = '';
  };

  return (
    <div style={{ flexShrink: 0, borderTop: '1px solid var(--color-border)', background: 'var(--color-pane)', padding: mobile ? '10px 16px' : '10px 12px calc(10px + env(safe-area-inset-bottom))' }}>
      <div style={{ maxWidth: 768, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {images.length > 0 && (
          <div style={{ display: 'flex', gap: 6 }}>
            {images.map((im, k) => (
              <div key={k} style={{ position: 'relative' }}>
                <img src={`data:${im.media_type};base64,${im.data}`} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8 }} />
                <button type="button" aria-label="Remove image" onClick={() => setImages(images.filter((_, j) => j !== k))}
                  style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, padding: 0, borderRadius: '50%', border: 'none', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                  <X size={11} weight="bold" />
                </button>
              </div>
            ))}
          </div>
        )}
        {sendError && <div role="alert" style={{ fontSize: 12.5, color: 'var(--color-status-red)', wordBreak: 'break-word' }}>{sendError}</div>}
        <ProjectSelect value={project} onChange={setProject} />
        <div data-testid="composer-row" style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <button type="button" aria-label="Attach image" onClick={() => fileRef.current?.click()} style={iconBtn}><Paperclip size={18} /></button>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => void onFiles(e)} />
          <textarea aria-label="Message" value={text} rows={1} placeholder="Message Dispatch…"
            onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
            style={{ flex: 1, minWidth: 0, resize: 'none', maxHeight: 200, padding: '8px 12px', borderRadius: 10, border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', fontSize: 16, lineHeight: 1.4, font: 'inherit' }} />
          <button type="button" aria-label="Send" disabled={!text.trim() && images.length === 0} onClick={() => void submit()}
            style={{ ...iconBtn, background: 'var(--color-accent)', border: 'none', color: '#06140B' }}>
            <ArrowUp size={18} weight="bold" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function EndlessColumn({ mobile = false }: { mobile?: boolean } = {}) {
  const messages = useEndless((s) => s.messages);
  const hasMore = useEndless((s) => s.hasMore);
  const loadingOlder = useEndless((s) => s.loadingOlder);
  const loadOlder = useEndless((s) => s.loadOlder);
  const atTail = useEndless((s) => s.atTail);
  const focus = useEndless((s) => s.focus);
  const loaded = useEndless((s) => s.loaded);
  const liveText = useEndless((s) => s.liveText);
  const liveThinking = useEndless((s) => s.liveThinking);
  const turn = useEndless((s) => s.turn);
  const busy = turn.status === 'waiting' || turn.status === 'running';

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    if (e.currentTarget.scrollTop < 120 && hasMore && !loadingOlder) void loadOlder();
  };

  return (
    <div className="chat-scope" style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
      <MessageScroller.Provider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={48}>
        <MessageScroller.Root style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
          <MessageScroller.Viewport preserveScrollOnPrepend onScroll={onScroll} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
            <MessageScroller.Content style={{ maxWidth: 768, margin: '0 auto', padding: mobile ? '24px 16px' : '24px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <LoadEarlierButton show={hasMore && !loadingOlder} onClick={() => void loadOlder()} />
              {loaded && messages.length === 0 && !busy && (
                <div style={{ margin: '20vh auto 0', color: 'var(--color-text-tertiary)', fontSize: 14 }}>One chat that never ends. Say something.</div>
              )}
              <EndlessRows messages={messages} focus={focus} />
              {liveThinking && <MessageScroller.Item messageId="__thinking"><Thinking text={liveThinking} /></MessageScroller.Item>}
              {liveText && (
                <MessageScroller.Item messageId="__live">
                  <div style={{ fontSize: 14.5, lineHeight: 1.75, minWidth: 0 }}><InsightText source={liveText} scheme="global" variant="rail" /></div>
                </MessageScroller.Item>
              )}
              {busy && <MessageScroller.Item messageId="__working" style={{ display: 'flex' }}><WorkingIndicator /></MessageScroller.Item>}
              {turn.status === 'failed' && <TurnError mobile={mobile} text={`The last turn failed: ${turn.error ?? 'unknown error'}`} />}
              {turn.status === 'interrupted' && <TurnError mobile={mobile} text="The daemon restarted during the last turn, so the turn stopped." />}
            </MessageScroller.Content>
          </MessageScroller.Viewport>
          <BootstrapOlder />
          <FocusScroll />
        </MessageScroller.Root>
      </MessageScroller.Provider>
      {!atTail && (
        <button type="button" onClick={() => void useEndless.getState().loadTail()}
          style={{ alignSelf: 'center', margin: '6px 0', padding: '5px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 12 }}>
          Back to latest
        </button>
      )}
      <Composer mobile={mobile} />
    </div>
  );
}
