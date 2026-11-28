import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type UIEvent } from 'react';
import { MessageScroller, useMessageScroller } from '@shadcn/react/message-scroller';
import { Rows, X } from '@phosphor-icons/react';
import { useEndless } from '../../stores/endless';
import { useProjects } from '../../stores/projects';
import { useDraft, appendToDraft } from '../../hooks/useDraft';
import { useBootstrapOlderPages } from '../../hooks/useBootstrapOlderPages';
import { LoadEarlierButton, Thinking } from '../tabs/chat/ChatView';
import { InsightText } from '../InsightText';
import { WorkingIndicator } from '../WorkingIndicator';
import { ImageViewerHost } from '../ChatImage';
import { PendingUserRow, FileChip } from './EndlessMessageRow';
import { ChatTimeline } from './timeline';
import { rowKeyOf } from './convItems';
import { ProjectMenuSection } from './ProjectPicker';

import { ClaudeLogin, isClaudeAuthError } from './ClaudeLogin';
import { api } from '../../api/client';
import { useChatAccount } from './ChatAccount';
import { RunningPill } from './ChatThreads';
import { PillComposer } from '../composer/PillComposer';
import { useSlashMenu, runModelEffortCommand } from '../composer/slash/useSlashMenu';
import { usePickerRequest } from '../../stores/pickerRequest';
import { modelOptionsFor } from '../../lib/modelName';
import { ChatModelSwitcher } from './ChatModelSwitcher';
import { useChatSettings } from './useChatSettings';
import { useDictation } from '../../hooks/useDictation';
import { useSettings } from '../../stores/settings';
import type { EndlessImage, EndlessFile } from '../../api/types';
import { hostCopy } from '../../lib/hostCopy';
import { MODEL_IMAGE_MIME, fileToBase64, chatDocType, CHAT_ACCEPT, CHAT_DOC_MAX_BYTES } from '../../lib/image-attach';
import { fontVar } from '../../lib/fontSize';

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
function FocusScroll({ restoring }: { restoring: boolean }) {
  const focus = useEndless((s) => s.focus);
  const sendCount = useEndless((s) => s.sendCount);
  const messages = useEndless((s) => s.messages);
  const { scrollToMessage, scrollToEnd } = useMessageScroller();
  // A return to Chat puts the reader back where they were (RestoreScroll): the focus they had
  // already reached is not jumped to again.
  const scrolledFocus = useRef<number | null>(restoring ? focus : null);
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

/** Same as the Provider's scrollEdgeThreshold: closer than this to the end counts as at the end. */
const EDGE_PX = 48;

/** Where the reader was: the first message on screen and its top relative to the viewport top. */
type ScrollSpot = { id: string; offset: number };

/**
 * Where the reader was when Chat last unmounted (another view, a thread). null after a full
 * reload, so a reload still opens at the end. A spot of null means the reader was at the end.
 */
let savedSpot: { spot: ScrollSpot | null } | null = null;

/** Test hook: forget the saved spot, as a reload does. */
export function resetChatScrollForTest(): void { savedSpot = null; }

function readSpot(viewport: HTMLElement, content: HTMLElement): ScrollSpot | null {
  if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= EDGE_PX) return null;
  const top = viewport.getBoundingClientRect().top;
  // The scroller's items are the content's direct children (the same rows it anchors a prepend on).
  for (const el of Array.from(content.children)) {
    const id = el instanceof HTMLElement ? el.dataset.messageId : undefined;
    if (!id) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom > top) return { id, offset: r.top - top };
  }
  return null;
}

/**
 * Chat unmounts when the user opens another view. On the way out this saves the first message on
 * screen; on the way back it puts that message at the same place, by its id, not by scrollTop:
 * messages that arrived while away, or an older page, change the heights. It runs after the
 * scroller's own first scroll to the end, in the same commit, so the end never paints. A reader who
 * was at the end gets the end, and the scroller follows new messages as before.
 */
function RestoreScroll() {
  const { scrollToMessage } = useMessageScroller();
  // React 18 passes no ref to the scroller's parts, and a parent's ref is not set yet when this
  // layout effect runs. A marker of its own, beside the viewport in the Root, finds them.
  const mark = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const spot = savedSpot?.spot ?? null;
    savedSpot = null;
    const vp = mark.current?.parentElement?.querySelector<HTMLElement>(':scope > [data-chat-viewport]') ?? null;
    const box = vp?.querySelector<HTMLElement>(':scope > [data-chat-content]') ?? null;
    if (spot && vp && box) {
      const el = Array.from(box.children).find((c) => c instanceof HTMLElement && c.dataset.messageId === spot.id);
      // align 'start' puts the row at the content's top padding plus scrollMargin: take the padding off.
      if (el) scrollToMessage(spot.id, { align: 'start', scrollMargin: spot.offset - (parseFloat(getComputedStyle(box).paddingTop) || 0) });
    }
    // The elements are taken now. On unmount the nodes are still in the page when this cleanup
    // runs, so they can still be measured.
    return () => { if (vp && box) savedSpot = { spot: readSpot(vp, box) }; };
    // Once per mount: a later render must not move the reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <span ref={mark} hidden />;
}

/** How long the key stays a Send after a send ends (see settling in Composer). */
const SETTLE_MS = 400;

// Draft storage holds text only. A send that fails after the user left Chat saves its text, but its
// images are dropped; this notice says so the next time the composer shows (or now, if one is showing).
// The notice lives in memory only: after a PWA reload the text is still in the draft, but the notice is gone.
const IMAGES_LOST = 'dispatch:chat-images-lost';
let imagesLostCount = 0; // images dropped by failures that no composer has shown yet
let imagesLostHadText = false; // whether any of those failures had text that went back to the draft
const imagesLostText = (n: number, hadText: boolean) => {
  const images = n === 1 ? '1 attachment was' : `${n} attachments were`;
  return `A message failed to send after you left Chat. ${hadText ? `Its text is back in the draft, but its ${images} not saved.` : `Its ${images} not saved.`} Attach again to retry.`;
};
const pendingImagesLost = () => (imagesLostCount ? imagesLostText(imagesLostCount, imagesLostHadText) : null);
const clearImagesLost = () => { imagesLostCount = 0; imagesLostHadText = false; };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The sign-in of the account that runs Chat. Chat on the default account: the generic card. Chat switched
 * to an account of its own: that account is signed in again (the generic card would repair the default).
 * The computer's CLI login cannot be repaired from here.
 */
function ChatSignIn({ onDone }: { onDone: () => void }) {
  const { pinned, label } = useChatAccount();
  if (pinned === 'cli') return <div style={{ fontSize: fontVar(12.5), color: 'var(--color-text-secondary)' }}>Chat runs on the CLI login of the daemon's computer. Run claude there and sign in, or pick another account with the usage ring.</div>;
  if (pinned) return <ClaudeLogin buttonLabel={`Sign in again to ${label ?? 'this account'}`} start={() => api.accountsClaudeLogin(label ?? '', pinned)} onDone={onDone} />;
  return <ClaudeLogin offerSaved onDone={onDone} />;
}

function TurnError({ text, mobile = false }: { text: string; mobile?: boolean }) {
  const [retryError, setRetryError] = useState<string | null>(null);
  const retry = () => {
    setRetryError(null);
    useEndless.getState().retry().catch((err: unknown) => setRetryError(`Retry failed: ${errorText(err)}`));
  };
  return (
    <div role="alert" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, padding: mobile ? '10px 16px' : '10px 12px', border: '1px solid var(--color-status-red)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', fontSize: fontVar(13.5) }}>
      <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{text}{retryError && <><br />{retryError}</>}</span>
      <button type="button" onClick={retry} style={{ flexShrink: 0, padding: '5px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', cursor: 'pointer' }}>Retry</button>
      {/* A login problem: log the daemon in from here, then send the message again. */}
      {isClaudeAuthError(text) && <div style={{ flexBasis: '100%' }}><ChatSignIn onDone={retry} /></div>}
    </div>
  );
}

export function Composer({ mobile = false }: { mobile?: boolean } = {}) {
  // The unsent text survives a reload, like the other composers' drafts.
  const [text, setText] = useDraft('chat');
  // The composer's left control is a + that opens up to Add file / Dictate (the thread
  // composers' InputActionsMenu). A confirmed transcript is added to the end of the draft.
  const textRef = useRef(text); textRef.current = text; // the latest text: the clear after an awaited send, and dictation
  const sttConfigured = useSettings((s) => !!s.sttProvider && !!s.sttModel && !!s.sttSecretName);
  const dictation = useDictation((spoken) => {
    const cur = textRef.current;
    setText(cur.trim() ? `${cur.replace(/\s+$/, '')} ${spoken}` : spoken);
  });
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [dragActive, setDragActive] = useState(false); // drives the drop-target cue
  const [images, setImages] = useState<EndlessImage[]>([]);
  // Documents (PDF, TXT, MD, CSV, JSON) ride along as base64 like images; the daemon saves them and
  // names their paths for the model. 2026-10-28: before this, a PDF could not be attached on a phone.
  const [files, setFiles] = useState<EndlessFile[]>([]);
  const [project, setProject] = useState<string | null>(null);
  const projectName = useProjects((s) => s.sessions.find((x) => x.id === project)?.name ?? null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [sendError, setSendError] = useState<string | null>(pendingImagesLost);
  // Skipped or unreadable attachments. Apart from sendError so a later good attach clears it and it never hides a send failure.
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  useEffect(() => {
    // The initializer only reads (React StrictMode renders it twice); the notice is spent after the commit.
    clearImagesLost();
    const show = () => { const m = pendingImagesLost(); if (m) { setSendError(m); clearImagesLost(); } };
    window.addEventListener(IMAGES_LOST, show);
    return () => window.removeEventListener(IMAGES_LOST, show);
  }, []);
  const sending = useRef(false);
  // The same fact as state, so the button stays a disabled Send (not Stop) while a send is in flight.
  const [sendingNow, setSendingNow] = useState(false);
  // Pasted or dropped images are read asynchronously; a send before the read ends would leave them for the next message.
  const readsRef = useRef(0);
  const [reading, setReading] = useState(false);
  // For a moment after a send ends the key stays a Send: a second tap that lands just as the send
  // resolves would otherwise hit a Stop and stop the turn it just started.
  const [settling, setSettling] = useState(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (settleTimer.current) clearTimeout(settleTimer.current); };
  }, []);
  const busy = useEndless((s) => s.turn.status === 'waiting' || s.turn.status === 'running');
  // The key is Stop only while a turn runs and the draft is empty: a message typed during a
  // turn still goes to the running process.
  const canSend = (!!text.trim() || images.length > 0 || files.length > 0) && !sendingNow && !reading;
  const stopMode = busy && !text.trim() && images.length === 0 && files.length === 0 && !sendingNow && !reading && !settling;
  const stop = () => {
    setSendError(null);
    useEndless.getState().stop().catch((err: unknown) => setSendError(`Stop failed: ${errorText(err)}`));
  };

  // The "/" menu: Chat's short list (/model, /effort, /stop). The model and effort are one Chat-wide setting, on the same
  // chip as a thread's. A refused change is also a visible line above the box (not only the chip's own status), like a failed send.
  const chat = useChatSettings();
  const applyChat = async (change: { model?: string | null; effort?: string | null }): Promise<string> => {
    try { return await chat.apply(change); }
    catch (err) { setSendError(`Model change refused: ${errorText(err)}`); throw err; }
  };
  const chatModels = modelOptionsFor('claude-code', [], chat.settings?.model ?? chat.settings?.defaultModel);
  const slash = useSlashMenu({
    surface: 'chat', harness: 'claude-code', value: text, setValue: setText, mobile,
    model: chat.settings ? chat.settings.model ?? chat.settings.defaultModel : null, effort: chat.settings?.effort ?? null,
    models: chatModels,
    run: async (name, args) => {
      if (name === 'stop') { await useEndless.getState().stop(); return; }
      if (!chat.settings) throw new Error(hostCopy('chat.settings.unavailable', 'Chat settings are not available on this daemon.'));
      if (name === 'model' || name === 'effort') {
        return runModelEffortCommand({
          harness: 'claude-code', name, args, models: chatModels,
          openPicker: () => usePickerRequest.getState().request('chat'),
          pickModel: async (value) => { await applyChat({ model: value }); return 'Saved for all of Chat. Applies from the next message.'; },
          pickEffort: async (level) => { await applyChat({ effort: level }); return 'Saved for all of Chat. Applies from the next message.'; },
        });
      }
    },
  });

  // Clear the draft the moment the send starts, not after it ends. The wait can last seconds on a
  // phone, and the user may keep typing, or the PWA may reload, during it. Clearing after the wait
  // left the sent text in the box (and in local storage), so the next send carried it again.
  // A failed send puts the text back in front of anything typed since, and shows why. After an unmount
  // it saves the text to the stored draft instead (appendToDraft), never into this dead composer.
  // Known trade-off: a reload during a slow send that then fails loses the text, since the draft
  // was already removed from local storage.
  const submit = async () => {
    const raw = text;
    const t = raw.trim();
    if ((!t && images.length === 0 && files.length === 0) || sending.current || readsRef.current > 0) return;
    const imgs = images;
    const docs = files;
    const proj = project;
    sending.current = true;
    setSendingNow(true);
    setSendError(null);
    setAttachNotice(null);
    setText('');
    textRef.current = ''; // render has not run yet; a reject before it must not see the old text
    setImages([]);
    setFiles([]);
    setProject(null);
    try {
      await useEndless.getState().send(t, proj, imgs, docs);
    } catch (err) {
      if (!mounted.current) {
        if (raw.trim()) appendToDraft('chat', raw);
        const lost = imgs.length + docs.length;
        if (lost) { imagesLostCount += lost; imagesLostHadText ||= !!raw.trim(); window.dispatchEvent(new Event(IMAGES_LOST)); }
        return;
      }
      const now = textRef.current;
      setText(now.trim() ? `${raw} ${now}` : raw);
      setImages((cur) => [...imgs, ...cur]);
      setFiles((cur) => [...docs, ...cur]);
      setProject((cur) => cur ?? proj);
      setSendError(`Send failed: ${errorText(err)}`);
    } finally {
      sending.current = false;
      if (mounted.current) {
        setSendingNow(false);
        setSettling(true);
        if (settleTimer.current) clearTimeout(settleTimer.current);
        settleTimer.current = setTimeout(() => setSettling(false), SETTLE_MS);
      }
    }
  };
  // Picked, dropped and pasted files all take this path. An image the model can see becomes an
  // image block; a document Chat takes (PDF, TXT, MD, CSV, JSON) is sent as base64 for the daemon
  // to save and name by path. Anything else is named in a notice, never dropped without a word.
  const addFiles = async (list: Iterable<File> | null | undefined) => {
    const all = [...(list ?? [])];
    const imgs = all.filter((f) => MODEL_IMAGE_MIME.has(f.type));
    const docs = all.filter((f) => !MODEL_IMAGE_MIME.has(f.type) && chatDocType(f) !== null && f.size <= CHAT_DOC_MAX_BYTES);
    const tooBig = all.filter((f) => !MODEL_IMAGE_MIME.has(f.type) && chatDocType(f) !== null && f.size > CHAT_DOC_MAX_BYTES);
    const other = all.filter((f) => !MODEL_IMAGE_MIME.has(f.type) && chatDocType(f) === null);
    const notes: string[] = [];
    const list3 = (fs: File[]) => { const names = fs.map((f) => f.name || f.type || 'a file'); return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3} more` : names.join(', '); };
    if (other.length) notes.push(`${list3(other)} not attached: Chat takes images (PNG, JPEG, GIF, WebP) and documents (PDF, TXT, MD, CSV, JSON).`);
    if (tooBig.length) notes.push(`${list3(tooBig)} not attached: a document can be up to 20 MB.`);
    setAttachNotice(notes.join(' ') || null);
    if (!imgs.length && !docs.length) return;
    readsRef.current += 1;
    setReading(true);
    try {
      const readImgs = await Promise.allSettled(imgs.map(async (f) => ({ media_type: f.type, data: await fileToBase64(f) })));
      const readDocs = await Promise.allSettled(docs.map(async (f) => ({ name: f.name, media_type: chatDocType(f)!, data: await fileToBase64(f) })));
      const addImgs = readImgs.flatMap((x) => (x.status === 'fulfilled' ? [x.value] : []));
      const addDocs = readDocs.flatMap((x) => (x.status === 'fulfilled' ? [x.value] : []));
      const failed = [...readImgs, ...readDocs].flatMap((x) => (x.status === 'rejected' ? [x.reason] : []));
      if (mounted.current) {
        // Merge into the notice on screen, never replace it: a newer pick may have written its own by now.
        if (failed.length) {
          const fail = `Could not read the file: ${errorText(failed[0])}`;
          setAttachNotice((cur) => (cur?.includes(fail) ? cur : cur ? `${cur} ${fail}` : fail));
        }
        if (addImgs.length) setImages((prev) => [...prev, ...addImgs]);
        if (addDocs.length) setFiles((prev) => [...prev, ...addDocs]);
      }
    } finally {
      readsRef.current -= 1;
      if (mounted.current && readsRef.current === 0) setReading(false);
    }
  };
  const onFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    await addFiles(input.files);
    input.value = '';
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    // Take over the paste only for files Chat can attach; a text paste, and a file it cannot take, stay a paste.
    const picked = [...(e.clipboardData?.files ?? [])].filter((f) => MODEL_IMAGE_MIME.has(f.type) || chatDocType(f) !== null);
    if (picked.length) { e.preventDefault(); void addFiles(picked); }
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
    // A text drag into the box must drop its text: take over only a file drop.
    if (Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
  };

  return (
    <div onDragOver={onDragOver} onDragEnter={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
      style={{ flexShrink: 0, borderTop: '1px solid var(--color-border)', background: dragActive ? 'color-mix(in srgb, var(--color-accent) 10%, var(--color-pane))' : 'var(--color-pane)', outline: dragActive ? '1px solid var(--color-accent)' : 'none', outlineOffset: -1, padding: mobile ? '10px 16px' : '10px 12px calc(10px + env(safe-area-inset-bottom))' }}>
      <div style={{ maxWidth: 768, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {dragActive && <div style={{ fontSize: fontVar(12), color: 'var(--color-accent)' }}>Drop to attach</div>}
        {(project !== null || images.length > 0 || files.length > 0) && (
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
            {project !== null && (
              <div data-testid="project-pill" style={{ display: 'flex', alignItems: 'center', gap: 6, maxWidth: '100%', height: 28, padding: '0 6px 0 9px', borderRadius: 'var(--radius-pill)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-secondary)', fontSize: fontVar(13) }}>
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
                <img src={`data:${im.media_type};base64,${im.data}`} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 'var(--radius-md)' }} />
                <button type="button" aria-label="Remove image" onClick={() => setImages(images.filter((_, j) => j !== k))}
                  style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, padding: 0, borderRadius: '50%', border: 'none', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                  <X size={11} weight="bold" />
                </button>
              </div>
            ))}
            {files.map((f, k) => (
              <div key={`f${k}`} style={{ position: 'relative' }}>
                <FileChip name={f.name} />
                <button type="button" aria-label="Remove file" title={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== k))}
                  style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, padding: 0, borderRadius: '50%', border: 'none', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                  <X size={11} weight="bold" />
                </button>
              </div>
            ))}
          </div>
        )}
        {sendError && <div role="alert" style={{ fontSize: fontVar(12.5), color: 'var(--color-status-red)', wordBreak: 'break-word' }}>{sendError}</div>}
        {attachNotice && <div role="alert" style={{ fontSize: fontVar(12.5), color: 'var(--color-status-red)', wordBreak: 'break-word' }}>{attachNotice}</div>}
        {/* The shared composer (composer/PillComposer.tsx). The + holds Project and Add file. */}
        <input ref={fileRef} type="file" accept={CHAT_ACCEPT} multiple hidden onChange={(e) => void onFiles(e)} />
        <PillComposer
            pluginContext={{ surface: 'chat' }}
          value={text}
          onChange={setText}
          onSend={() => { if (slash.interceptSend()) return; void submit(); }}
          canSend={canSend}
          stopMode={stopMode}
          onStop={stop}
          placeholder="Message Dispatch…"
          onAddFile={() => fileRef.current?.click()}
          menuExtra={(close) => (<>{slash.plusRow(close)}<ProjectMenuSection value={project} onChange={setProject} close={close} mobile={mobile} /></>)}
          slash={slash.overlay}
          dictation={dictation}
          sttConfigured={sttConfigured}
          textareaRef={taRef}
          textareaProps={{ 'aria-label': 'Message', onPaste, onKeyDown: slash.onKeyDown }}
          mobile={mobile}
        />
        {/* The model and effort card of all of Chat. It draws nothing until the header or the "/" menu asks. */}
        {chat.settings && <ChatModelSwitcher settings={chat.settings} apply={applyChat} reload={chat.reload} />}
      </div>
    </div>
  );
}

export function EndlessColumn({ mobile = false, onShowThreads, threadsShown = false }: {
  mobile?: boolean;
  /** The running pill's tap: show the one list of Chat's threads. */
  onShowThreads?: () => void;
  /** That list is already beside the messages (the desktop's right column), so the pill would repeat it. */
  threadsShown?: boolean;
} = {}) {
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
  // Read once per mount: whether this mount returns to a spot the reader left (RestoreScroll).
  const [restoring] = useState(() => !!savedSpot?.spot);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    if (e.currentTarget.scrollTop < 120 && hasMore && !loadingOlder) void loadOlder();
  };

  return (
    <ImageViewerHost>
    <div className="chat-scope" style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
      <MessageScroller.Provider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={48}>
        <MessageScroller.Root style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
          <MessageScroller.Viewport data-chat-viewport="" preserveScrollOnPrepend onScroll={onScroll} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
            <MessageScroller.Content data-chat-content="" style={{ maxWidth: 768, margin: '0 auto', padding: mobile ? '24px 16px' : '24px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <LoadEarlierButton show={hasMore && !loadingOlder} onClick={() => void loadOlder()} />
              {loaded && messages.length === 0 && !busy && (
                <div style={{ margin: '20vh auto 0', color: 'var(--color-text-tertiary)', fontSize: fontVar(14) }}>One chat that never ends. Say something.</div>
              )}
              <ChatTimeline messages={messages} focus={focus} />
              {atTail && pending.map((p) => (
                <MessageScroller.Item key={`p${p.id}`} messageId={`p${p.id}`} style={{ display: 'flex', flexDirection: 'column' }}>
                  <PendingUserRow text={p.text} projectName={p.projectName} images={p.images} files={p.files} />
                </MessageScroller.Item>
              ))}
              {liveThinking && <MessageScroller.Item messageId="__thinking"><Thinking text={liveThinking} /></MessageScroller.Item>}
              {liveText && (
                <MessageScroller.Item messageId="__live">
                  <div style={{ fontSize: fontVar(14.5), lineHeight: 1.75, minWidth: 0 }}><InsightText source={liveText} scheme="global" variant="rail" /></div>
                </MessageScroller.Item>
              )}
              {busy && <MessageScroller.Item messageId="__working" style={{ display: 'flex' }}><WorkingIndicator /></MessageScroller.Item>}
              {turn.status === 'failed' && <TurnError mobile={mobile} text={`The last turn failed: ${turn.error ?? 'unknown error'}`} />}
              {turn.status === 'interrupted' && <TurnError mobile={mobile} text={hostCopy('thread.interrupted', 'The daemon restarted during the last turn, so the turn stopped.')} />}
            </MessageScroller.Content>
          </MessageScroller.Viewport>
          {!threadsShown && <RunningPill onOpen={onShowThreads} />}
          <RestoreScroll />
          <BootstrapOlder />
          <FocusScroll restoring={restoring} />
        </MessageScroller.Root>
      </MessageScroller.Provider>
      {!atTail && (
        <button type="button" onClick={() => void useEndless.getState().loadTail()}
          style={{ alignSelf: 'center', margin: '6px 0', padding: '5px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: fontVar(12) }}>
          Back to latest
        </button>
      )}
      <Composer mobile={mobile} />
    </div>
    </ImageViewerHost>
  );
}
