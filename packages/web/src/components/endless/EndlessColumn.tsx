import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent, type UIEvent } from 'react';
import { MessageScroller, useMessageScroller } from '@shadcn/react/message-scroller';
import { ArrowUp, Paperclip, Rows, Stop, X } from '@phosphor-icons/react';
import { useEndless } from '../../stores/endless';
import { useProjects } from '../../stores/projects';
import { useDraft } from '../../hooks/useDraft';
import { useBootstrapOlderPages } from '../../hooks/useBootstrapOlderPages';
import { LoadEarlierButton, Thinking } from '../tabs/chat/ChatView';
import { InsightText } from '../InsightText';
import { WorkingIndicator } from '../WorkingIndicator';
import { EndlessRows, PendingUserRow, rowKeyOf } from './EndlessMessageRow';
import { ProjectPicker, iconBtn } from './ProjectPicker';
import { ClaudeLogin, isClaudeAuthError } from './ClaudeLogin';
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
  const sendCount = useEndless((s) => s.sendCount);
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
  // Each send follows the end, also when the reader scrolled up or jumped inside the tail.
  const prevSend = useRef(sendCount);
  useEffect(() => {
    if (prevSend.current === sendCount) return;
    prevSend.current = sendCount;
    scrollToEnd({ behavior: 'auto' });
  }, [sendCount, scrollToEnd]);
  return null;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function TurnError({ text, mobile = false }: { text: string; mobile?: boolean }) {
  const [retryError, setRetryError] = useState<string | null>(null);
  const retry = () => {
    setRetryError(null);
    useEndless.getState().retry().catch((err: unknown) => setRetryError(`Retry failed: ${errorText(err)}`));
  };
  return (
    <div role="alert" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, padding: mobile ? '10px 16px' : '10px 12px', border: '1px solid var(--color-status-red)', borderRadius: 8, color: 'var(--color-text-primary)', fontSize: 13.5 }}>
      <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{text}{retryError && <><br />{retryError}</>}</span>
      <button type="button" onClick={retry} style={{ flexShrink: 0, padding: '5px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', cursor: 'pointer' }}>Retry</button>
      {/* A login problem: log the daemon in from here, then send the message again. */}
      {isClaudeAuthError(text) && <div style={{ flexBasis: '100%' }}><ClaudeLogin onDone={retry} /></div>}
    </div>
  );
}

export function Composer({ mobile = false }: { mobile?: boolean } = {}) {
  // The unsent text survives a reload, like the other composers' drafts.
  const [text, setText] = useDraft('chat');
  const textRef = useRef(text); textRef.current = text; // the latest text, for the clear after an awaited send
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [dragActive, setDragActive] = useState(false); // drives the drop-target cue
  const [images, setImages] = useState<EndlessImage[]>([]);
  const [project, setProject] = useState<string | null>(null);
  const projectName = useProjects((s) => s.sessions.find((x) => x.id === project)?.name ?? null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const sending = useRef(false);
  const busy = useEndless((s) => s.turn.status === 'waiting' || s.turn.status === 'running');
  // The key is Stop only while a turn runs and the draft is empty: a message typed during a
  // turn still goes to the running process.
  const stopMode = busy && !text.trim() && images.length === 0;
  const stop = () => {
    setSendError(null);
    useEndless.getState().stop().catch((err: unknown) => setSendError(`Stop failed: ${errorText(err)}`));
  };

  // Clear the draft the moment the send starts, not after it ends. The wait can last seconds on a
  // phone, and the user may keep typing, or the PWA may reload, during it. Clearing after the wait
  // left the sent text in the box (and in local storage), so the next send carried it again.
  // A failed send puts the text back in front of anything typed since, and shows why.
  const submit = async () => {
    const raw = text;
    const t = raw.trim();
    if ((!t && images.length === 0) || sending.current) return;
    const imgs = images;
    const proj = project;
    sending.current = true;
    setSendError(null);
    setText('');
    setImages([]);
    setProject(null);
    try {
      await useEndless.getState().send(t, proj, imgs);
    } catch (err) {
      const now = textRef.current;
      setText(now.trim() ? `${raw} ${now}` : raw);
      setImages((cur) => [...imgs, ...cur]);
      setProject((cur) => cur ?? proj);
      setSendError(`Send failed: ${errorText(err)}`);
    } finally {
      sending.current = false;
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
  };
  // Picked, dropped and pasted files all take this one path. Only the image types the model
  // can read are kept: Chat has no project inbox to hold other files.
  const addImages = async (list: Iterable<File> | null | undefined) => {
    const files = [...(list ?? [])].filter((f) => MODEL_IMAGE_MIME.has(f.type));
    const add = await Promise.all(files.map(async (f) => ({ media_type: f.type, data: await fileToBase64(f) })));
    if (add.length) setImages((prev) => [...prev, ...add]);
  };
  const onFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    await addImages(input.files);
    input.value = '';
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => MODEL_IMAGE_MIME.has(f.type));
    if (files.length) { e.preventDefault(); void addImages(files); }
  };
  // Gate on a FILE drag so the cue does not flash on text drags.
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    setDragActive(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragActive(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files?.length) void addImages(e.dataTransfer.files);
  };
  // Grow with the text up to 200px, then scroll. Runs on every text change, so a paste, a
  // draft restore and the clear after a send all resize the box.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [text]);

  return (
    <div onDragOver={onDragOver} onDragEnter={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
      style={{ flexShrink: 0, borderTop: '1px solid var(--color-border)', background: dragActive ? 'color-mix(in srgb, var(--color-accent) 10%, var(--color-pane))' : 'var(--color-pane)', outline: dragActive ? '1px solid var(--color-accent)' : 'none', outlineOffset: -1, padding: mobile ? '10px 16px' : '10px 12px calc(10px + env(safe-area-inset-bottom))' }}>
      <div style={{ maxWidth: 768, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {dragActive && <div style={{ fontSize: 12, color: 'var(--color-accent)' }}>Drop image to attach</div>}
        {(project !== null || images.length > 0) && (
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
            {project !== null && (
              <div data-testid="project-pill" style={{ display: 'flex', alignItems: 'center', gap: 6, maxWidth: '100%', height: 28, padding: '0 6px 0 9px', borderRadius: 999, border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-secondary)', fontSize: 13 }}>
                <Rows size={14} />
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{projectName ?? project}</span>
                <button type="button" aria-label="Remove project" onClick={() => setProject(null)}
                  style={{ width: 18, height: 18, padding: 0, flexShrink: 0, border: 'none', borderRadius: '50%', background: 'transparent', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                  <X size={11} weight="bold" />
                </button>
              </div>
            )}
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
        <div data-testid="composer-row" style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <ProjectPicker value={project} onChange={setProject} mobile={mobile} />
          <button type="button" aria-label="Attach image" onClick={() => fileRef.current?.click()} style={iconBtn}><Paperclip size={18} /></button>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => void onFiles(e)} />
          <textarea ref={taRef} aria-label="Message" value={text} rows={1} enterKeyHint="send" onPaste={onPaste} placeholder="Message Dispatch…"
            onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
            style={{ flex: 1, minWidth: 0, resize: 'none', maxHeight: 200, overflowY: 'auto', padding: '8px 12px', borderRadius: 10, border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', fontSize: 16, lineHeight: 1.4, font: 'inherit' }} />
          {stopMode ? (
            <button type="button" aria-label="Stop" title="Stop" onClick={stop}
              style={{ ...iconBtn, background: 'color-mix(in srgb, var(--color-status-red) 20%, transparent)', border: 'none', color: 'var(--color-status-red)' }}>
              <Stop size={16} weight="fill" />
            </button>
          ) : (
            <button type="button" aria-label="Send" disabled={!text.trim() && images.length === 0} onClick={() => void submit()}
              style={{ ...iconBtn, background: 'var(--color-accent)', border: 'none', color: '#06140B' }}>
              <ArrowUp size={18} weight="bold" />
            </button>
          )}
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
  const pending = useEndless((s) => s.pending);
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
              {atTail && pending.map((p) => (
                <MessageScroller.Item key={`p${p.id}`} messageId={`p${p.id}`} style={{ display: 'flex', flexDirection: 'column' }}>
                  <PendingUserRow text={p.text} projectName={p.projectName} images={p.images} />
                </MessageScroller.Item>
              ))}
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
