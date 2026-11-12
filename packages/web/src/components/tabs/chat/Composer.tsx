import { memo, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';
import { X } from '@phosphor-icons/react';
import type { Terminal } from '../../../api/types';
import { api, type ContentBlock } from '../../../api/client';
import { useDraft } from '../../../hooks/useDraft';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { useSettings } from '../../../stores/settings';
import { useDictation } from '../../../hooks/useDictation';
import { PillComposer } from '../../composer/PillComposer';
import { UploadTray, useInboxUploads } from '../../composer/UploadTray';
import { useThreadModelControls } from './modelControls';
import { useSlashMenu, runModelEffortCommand } from '../../composer/slash/useSlashMenu';
import { usePickerRequest } from '../../../stores/pickerRequest';
import { useTransportSwitch } from '../../layout/TransportToggle';
import { ConfirmModal } from '../../common/ConfirmModal';
import { textToSend } from '../../../lib/slashEscape';
import { MODEL_IMAGE_MIME, fileToBase64 } from '../../../lib/image-attach';
import { askLook } from './askLook';

export interface ComposerProps {
  terminalId: string;
  /** The thread's project: uploads go to its inbox. Undefined until the thread is loaded. */
  sessionId?: string;
  /** The thread, for the "/" menu's model and effort lists. */
  tab?: Terminal;
  /** A turn is in flight: over an empty composer the send key becomes Stop. */
  busy: boolean;
  /** A turn runs or is parked on a question: /model and /effort refuse, and /restart asks to stop it. */
  turnRuns: boolean;
  /** One turn: plain text, or a text block and the staged images. Keep it stable (the composer is memoized). */
  onSend(content: string | ContentBlock[]): void;
  /** The status row under the text box (model switcher, send hint, context meter). Keep it stable. */
  footer?: ReactNode;
}

/**
 * The thread composer (W1-F), split out of ChatView. It OWNS the draft, the staged images, the
 * uploads, dictation, the "/" menu and the send key. ChatView used to hold the draft, so every
 * key press rendered ChatView and walked the whole timeline again (renderTimeline, twice per key
 * press in a 500-item chat). Now a key press renders this component only.
 *
 * Memoized: ChatView renders on every streamed delta, and none of that concerns the composer.
 */
export const Composer = memo(function Composer({ terminalId, sessionId, tab, busy, turnRuns, onSend, footer }: ComposerProps) {
  const [draft, setDraft, clearDraft] = useDraft(terminalId);
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

  function doSend() {
    // A command typed in the box (/model, /compact…) is Dispatch's to run, never the model's.
    if (slash.interceptSend()) return;
    const v = textToSend(draft);
    if (!v && stagedImages.length === 0) return;
    // Text + any staged images go out as ONE turn: a leading text block (when there's a
    // caption) followed by the image blocks. Falls back to a plain string turn when nothing
    // is staged, matching the previous behavior for text-only sends.
    if (stagedImages.length) {
      onSend(v ? [{ type: 'text', text: v }, ...stagedImages] : [...stagedImages]);
      setStagedImages([]);
    } else {
      onSend(v);
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
  const [askRestart, setAskRestart] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
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

  return (
    <>
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
            look={askLook() ? 'os' : undefined}
          />
        </div>

        {footer}
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
    </>
  );
});

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
