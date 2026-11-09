// Overseer view — directive composer (spec §6 "Composer", §7, §9).
//
// Layout: outer container (flex:none, border-top) > the shared PillComposer (+ | text | mic | ↑)
//         + hint row (right-aligned "⌘↵ send" / "Ctrl+↵ send" per host OS, desktop only).
// Draft text: owned locally via useDraft(coordinatorProject) — NOT a store field, so
//   each project's Dispatch tab keeps its own draft (mirrors the agent ChatView's
//   per-terminal draft). Store: composerImages, sendDirective(text), openDelegate.
// Interactions: Enter → sendDirective + clear draft; the box grows to half the window, then scrolls.
// A click on the pinned decision card appends its answer to the draft (store.addToDraft): the box
//   takes the focus and a hint under it says what was added; the user presses Enter to send.
// Mobile: shorter placeholder ("Fire a directive…"); hint row is omitted.

import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { Icon } from '../atoms';
import { useOverseer, useComposerImages, coordinatorMatchesView } from '../store';
import { useProjects } from '../../../stores/projects';
import { useDraft } from '../../../hooks/useDraft';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { api } from '../../../api/client';
import { useDictation } from '../../../hooks/useDictation';
import { PillComposer } from '../../composer/PillComposer';
import { UploadTray, useInboxUploads } from '../../composer/UploadTray';
import { useSettings } from '../../../stores/settings';
import { ContextIndicator } from '../../ContextIndicator';
import { ModelSwitcher } from '../../tabs/chat/ModelSwitcher';
import { useThreadModelControls } from '../../tabs/chat/modelControls';
import { useSlashMenu, runModelEffortCommand } from '../../composer/slash/useSlashMenu';
import { usePickerRequest } from '../../../stores/pickerRequest';
import { useTabs, findTerminal } from '../../../stores/tabs';
import { modLabel } from '../../../lib/hostkeys';
import { CoordinatorMenu } from './CoordinatorMenu';
import { MODEL_IMAGE_MIME, fileToBase64 } from '../../../lib/image-attach';

/** A staged (pre-send) image preview with an × to drop it from the buffer. */
function StagedThumbnail({ src, onRemove }: { src: string; onRemove: () => void }) {
  return (
    <div style={{ position: 'relative', width: 48, height: 48, flex: 'none' }}>
      <img
        src={src}
        alt="attachment"
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)',
          display: 'block',
        }}
      />
      <button
        type="button"
        onClick={onRemove}
        title="Remove image"
        style={{
          position: 'absolute',
          top: -6,
          right: -6,
          width: 18,
          height: 18,
          padding: 0,
          borderRadius: '50%',
          background: 'var(--base)',
          border: '1px solid var(--border)',
          color: 'var(--ts)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          lineHeight: 1,
        }}
      >
        <Icon name="ph-x" weight="bold" size={10} color="var(--ts)" />
      </button>
    </div>
  );
}

export function Composer() {
  const sendDirective = useOverseer((s) => s.sendDirective);
  const addComposerImage = useOverseer((s) => s.addComposerImage);
  const removeComposerImage = useOverseer((s) => s.removeComposerImage);
  const coordinatorProject = useOverseer((s) => s.coordinatorProject);
  const coordinatorId = useOverseer((s) => s.coordinatorId);
  const activeId = useProjects((s) => s.activeId);
  // Same cross-tab gate as every coordinator read: never show (or act on) a coordinator
  // that belongs to another project while an ensureForProject swap is in flight.
  const showSessionMenu = !!coordinatorId && !!coordinatorProject && coordinatorMatchesView(coordinatorProject, activeId);
  const composerImages = useComposerImages();
  const coordinatorBusy = useOverseer((s) => s.coordinatorBusy);
  const coordinatorContextWindow = useOverseer((s) => s.coordinatorContextWindow);
  const coordinatorContextTokens = useOverseer((s) => s.coordinatorContextTokens);
  const coordinatorCompacting = useOverseer((s) => s.coordinatorCompacting);
  const coordinatorCompactResult = useOverseer((s) => s.coordinatorCompactResult);
  const coordinatorModel = useOverseer((s) => s.coordinatorModel);
  const compactCoordinator = useOverseer((s) => s.compactCoordinator);
  const imageCount = composerImages.length;
  const isMobile = useIsMobile();
  // Draft TEXT is scoped per coordinator project (not a global store field) — otherwise
  // every Dispatch tab (one per project) would share the SAME draft, leaking text
  // between unrelated projects. Mirrors the agent ChatView's per-terminal useDraft.
  const [composer, setComposer, clearComposer] = useDraft(coordinatorProject ?? '');
  // The pinned card's "Added N17: A" hint, for this project only (store.addToDraft).
  const draftHint = useOverseer((s) => (s.draftHint && s.draftHint.project === coordinatorProject ? s.draftHint : null));
  // Send/Stop key parity with the agent ChatView composer (see its stopMode doc):
  // Send needs a non-empty draft OR a staged image; over an EMPTY composer during an
  // in-flight turn the key becomes a Stop (graceful api.interrupt — the current turn
  // ends, the thread lives). Typing always wins: a drafted follow-up shows Send.
  const canSend = composer.trim().length > 0 || imageCount > 0;
  // showSessionMenu doubles as "this coordinator belongs to the viewed project" — the
  // exact gate a Stop needs too (never brake a foreign coordinator mid-swap).
  const stopMode = coordinatorBusy && !canSend && showSessionMenu;
  const doStop = () => {
    if (!coordinatorId) return;
    // Graceful: ends the CURRENT TURN and leaves the coordinator alive (the stream-json
    // `interrupt` control) — deliberately not a process kill.
    void api.interrupt(coordinatorId).catch(() => { /* best-effort */ });
  };
  // Mirror the draft in a ref so the async upload loop / dictation callback append to
  // the latest value (across awaits / multiple files) without clobbering it — same
  // pattern as ChatView's draftRef.
  const composerRef = useRef(composer); composerRef.current = composer;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const sttConfigured = useSettings((s) => !!s.sttProvider && !!s.sttModel && !!s.sttSecretName);
  const dictation = useDictation((text) => {
    const cur = composerRef.current;
    const next = cur + (cur ? ' ' : '') + text;
    composerRef.current = next;
    setComposer(next);
  });

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // A card click asks for the focus once; a later remount of the Composer does not take it again.
  useEffect(() => {
    if (!draftHint?.focus) return;
    textareaRef.current?.focus();
    useOverseer.getState().draftFocused();
  }, [draftHint]);
  const [dragActive, setDragActive] = useState(false); // drives the drop-target visual cue

  // Mirror the agent ChatView attach UX: upload each pick to the project inbox, then
  // send an IMAGE on as a real base64 block buffered for the next directive (the model
  // SEES it); a non-image appends a path-reference line to the composer text.
  // Each upload shows a progress tile with a cancel (composer/UploadTray.tsx).
  const uploader = useInboxUploads(coordinatorProject, async (res, f) => {
    if (MODEL_IMAGE_MIME.has(f.type)) {
      const data = await fileToBase64(f);
      addComposerImage({ type: 'image', source: { type: 'base64', media_type: f.type, data } });
    } else {
      const cur = composerRef.current;
      const next = cur + (cur ? '\n' : '') + 'Attached file: ' + res.path;
      composerRef.current = next;
      setComposer(next);
    }
  });
  const startUpload = uploader.start;
  const attachFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || !files.length || !coordinatorProject) return;
      for (const f of Array.from(files)) startUpload(f);
    },
    [coordinatorProject, startUpload],
  );

  // The "/" menu (composer/slash): /model and /effort for the overseer, on the same chip, lists and calls as a thread
  // (modelControls.ts). The overseer's model stays free (PS-2): an explicit model wins over the coordinator tier.
  const coordinatorTab = useTabs((s) => (coordinatorId ? findTerminal(s.byProject, coordinatorId) : undefined));
  const controls = useThreadModelControls(coordinatorTab ?? { id: coordinatorId ?? '', sessionId: '', type: 'claude-code', config: {} });
  const slashHarness = controls.harness ?? 'claude-code';
  const coordinatorPending = useOverseer((s) => s.coordinatorPending);
  // A turn parked on a question is still a turn that runs: the chip is off for it, like the daemon's 409.
  const turnRuns = coordinatorBusy || coordinatorCompacting || !!coordinatorPending || coordinatorTab?.status === 'needs_input';
  const slash = useSlashMenu({
    surface: 'overseer', harness: slashHarness, value: composer, setValue: setComposer, mobile: isMobile,
    model: controls.active ?? null, effort: controls.effort?.current ?? controls.effort?.defaultEffort ?? null,
    models: controls.options, effortLevels: controls.effort?.levels,
    run: async (name, args) => {
      if (name === 'stop') { doStop(); return; }
      if (!coordinatorId || !coordinatorTab) throw new Error('The Control Plane session has not started yet.');
      if (name === 'model' || name === 'effort') {
        return runModelEffortCommand({
          harness: slashHarness, name, args, models: controls.options, effortLevels: controls.effort?.levels,
          openPicker: () => {
            if (turnRuns) throw new Error(`The Control Plane is busy — change the ${name} when the turn ends`);
            usePickerRequest.getState().request(`thread:${coordinatorId}`);
          },
          pickModel: controls.pickModel, pickEffort: controls.pickEffort,
        });
      }
      if (name === 'compact') { compactCoordinator(); return; }
    },
  });

  // Return and the ↑ both land here (PillComposer handles the keys, Shift+Return and IME).
  const handleSend = useCallback(() => {
    if (slash.interceptSend()) return; // a typed command is Dispatch's to run, never the model's
    sendDirective(composer);
    clearComposer();
  }, [sendDirective, composer, clearComposer, slash]);

  // Drag-and-drop + paste image upload — route dropped/pasted files through the SAME
  // attachFiles path as the Paperclip (upload to inbox; an image rides along as a real
  // base64 block on the next directive, so the coordinator SEES it). Mirrors TerminalTab's
  // drop+paste pattern. Gate on a FILE drag so the cue doesn't flash on text/element drags.
  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    setDragActive(true);
  }, []);
  const onDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    // Only clear when the pointer truly leaves the composer (not when crossing a child),
    // so the cue doesn't flicker between the attach button / textarea / send button.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragActive(false);
  }, []);
  const onDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files?.length) void attachFiles(e.dataTransfer.files);
  }, [attachFiles]);
  const onPaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = e.clipboardData?.files;
    if (files && files.length) { e.preventDefault(); void attachFiles(files); }
  }, [attachFiles]);

  return (
    <div
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        flex: 'none',
        borderTop: '1px solid var(--border)',
        padding: '12px 16px 13px',
        background: 'var(--base)',
        position: 'relative',
      }}
    >
      {/* drag cue / upload status text (drag cue takes precedence while dragging) */}
      {dragActive && (
        <div style={{ maxWidth: 1200, margin: '0 auto 6px', fontSize: 11, color: 'var(--acc)' }}>Drop image to attach</div>
      )}
      <div style={{ maxWidth: 1200, margin: '0 auto' }}><UploadTray uploads={uploader.uploads} onCancel={uploader.cancel} /></div>

      {/* staged image thumbnails — each removable via its × (hidden behind the drag cue) */}
      {!dragActive && imageCount > 0 && (
        <div style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {composerImages.map((block, i) =>
            block.type === 'image' ? (
              <StagedThumbnail
                key={i}
                src={`data:${block.source.media_type};base64,${block.source.data}`}
                onRemove={() => removeComposerImage(i)}
              />
            ) : null,
          )}
        </div>
      )}

      {/* The shared composer (composer/PillComposer.tsx): + | text | mic | ↑. Images ride along
          with the next directive as real blocks; other files go to the inbox and add a path line.
          Capped and centred to line up with the message column above (Stream.tsx). The session
          menu (⋯) sits beside it on desktop; on mobile OverseerMobile.tsx puts it in the header. */}
      <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { void attachFiles(e.target.files); e.currentTarget.value = ''; }} />
      <div style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <PillComposer
            value={composer}
            onChange={setComposer}
            onSend={handleSend}
            /* Not while an upload runs: its image would miss this directive. */
            canSend={canSend && !uploader.busy}
            stopMode={stopMode}
            onStop={doStop}
            placeholder={isMobile ? 'Fire a directive…' : 'Fire a directive to Control Plane…'}
            onAddFile={() => fileInputRef.current?.click()}
            dictation={dictation}
            sttConfigured={sttConfigured}
            textareaRef={textareaRef}
            textareaProps={{ onPaste, onKeyDown: slash.onKeyDown }}
            dragActive={dragActive}
            mobile={isMobile}
            menuExtra={slash.plusRow}
            slash={slash.overlay}
            sendLabel="Send directive"
          />
        </div>
        {showSessionMenu && !isMobile && (
          <CoordinatorMenu terminalId={coordinatorId} sessionId={coordinatorProject} scheme="scoped" direction="up" />
        )}
      </div>

      {/* what the last pinned-card click added — nothing is sent until the user presses Enter */}
      {draftHint && (
        <div style={{ maxWidth: 1200, margin: '6px auto 0', fontSize: 11.5, color: 'var(--ts)' }}>
          Added {draftHint.text}. Press Enter to send, or keep adding.
        </div>
      )}

      {/* status row (always rendered, both mobile + desktop): context indicator left,
          primary-modifier "↵ send" keyboard hint right (desktop only) */}
      <div
        style={{
          maxWidth: 1200,
          margin: '8px auto 0',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        {coordinatorTab && coordinatorTab.type !== 'shell' && <span style={{ marginRight: 6, display: 'inline-flex' }}><ModelSwitcher tab={coordinatorTab} busy={turnRuns} /></span>}
        <ContextIndicator
          showModel={!coordinatorTab}
          contextTokens={coordinatorContextTokens}
          contextWindow={coordinatorContextWindow}
          compacting={coordinatorCompacting}
          compactResult={coordinatorCompactResult}
          model={coordinatorModel}
          compact={compactCoordinator}
        />
        {!isMobile && (
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              color: 'var(--tt)',
              marginLeft: 'auto',
            }}
          >
            {modLabel('↵')} send
          </span>
        )}
      </div>
    </div>
  );
}
