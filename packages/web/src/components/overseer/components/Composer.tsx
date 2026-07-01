// Overseer view — "Always listening" directive composer (spec §6 "Composer", §7, §9).
//
// Layout: outer container (flex:none, border-top) > input row ("+" | textarea | send)
//         + hint row (breathing dot · "Always listening…" · spacer · "⌘↵ send").
// Store: composer, setComposer, sendDirective, openDelegate (no prop drilling).
// Interactions: ⌘/Ctrl+Enter → sendDirective; autosizing textarea (rows 1, max 120px).
// Mobile: shorter placeholder ("Fire a directive…"); hint row omits the keyboard hint.

import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { Paperclip } from '@phosphor-icons/react';
import { Icon, StatusDot } from '../atoms';
import { useOverseer } from '../store';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { api } from '../../../api/client';
import { useDictation } from '../../../hooks/useDictation';
import { DictationControl } from '../../dictation/DictationControl';
import { InputActionsMenu } from '../../dictation/InputActionsMenu';
import { useSettings } from '../../../stores/settings';

// Anthropic-vision-supported image types (mirrors the agent ChatView). Only these
// become a REAL base64 image block the coordinator SEES; anything else falls back to a
// path-reference line in the composer (the agents can still Read it from the inbox).
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

export function Composer() {
  const composer = useOverseer((s) => s.composer);
  const setComposer = useOverseer((s) => s.setComposer);
  const sendDirective = useOverseer((s) => s.sendDirective);
  const addComposerImage = useOverseer((s) => s.addComposerImage);
  const coordinatorProject = useOverseer((s) => s.coordinatorProject);
  const imageCount = useOverseer((s) => s.composerImages.length);
  const isMobile = useIsMobile();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const sttConfigured = useSettings((s) => !!s.sttProvider && !!s.sttModel && !!s.sttSecretName);
  const dictation = useDictation((text) => {
    const cur = useOverseer.getState().composer;
    setComposer(cur + (cur ? ' ' : '') + text);
  });

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [uploadNote, setUploadNote] = useState('');
  const [dragActive, setDragActive] = useState(false); // drives the drop-target visual cue

  // Mirror the agent ChatView attach UX: upload each pick to the project inbox, then
  // send an IMAGE on as a real base64 block buffered for the next directive (the model
  // SEES it); a non-image appends a path-reference line to the composer text.
  const attachFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || !files.length || !coordinatorProject) return;
      for (const f of Array.from(files)) {
        setUploadNote(`Uploading ${f.name}…`);
        try {
          const res = await api.uploadInbox(coordinatorProject, f);
          if (MODEL_IMAGE_MIME.has(f.type)) {
            const data = await fileToBase64(f);
            addComposerImage({ type: 'image', source: { type: 'base64', media_type: f.type, data } });
            setUploadNote(`Attached ${f.name}`);
          } else {
            const cur = useOverseer.getState().composer;
            setComposer(cur + (cur ? '\n' : '') + 'Attached file: ' + res.path);
            setUploadNote(`Attached ${f.name}`);
          }
        } catch {
          setUploadNote(`Upload failed: ${f.name}`);
        }
      }
      setTimeout(() => setUploadNote(''), 2500);
    },
    [coordinatorProject, addComposerImage, setComposer],
  );

  // Auto-size: collapse to measure, then expand to content (max-height CSS caps at 120px).
  const autosize = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      autosize(e.currentTarget);
      setComposer(e.currentTarget.value);
    },
    [autosize, setComposer],
  );

  const resetHeight = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Don't submit mid-IME-composition: CJK candidate selection commits with Enter, so
      // firing the directive there would swallow the composition (important for CJK input).
      if (e.nativeEvent.isComposing) return;
      // Enter (without Shift) submits — this also covers the ⌘/Ctrl+Enter hint; Shift+Enter
      // inserts a newline. Mirrors the agent ChatView composer's submit behavior.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendDirective();
        resetHeight();
      }
    },
    [sendDirective, resetHeight],
  );

  const handleSend = useCallback(() => {
    sendDirective();
    resetHeight();
  }, [sendDirective, resetHeight]);

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
      {/* upload status / pending-image indicator (drag cue takes precedence while dragging) */}
      {(dragActive || uploadNote || imageCount > 0) && (
        <div style={{ fontSize: 11, color: dragActive ? 'var(--acc)' : 'var(--tt)', marginBottom: 6 }}>
          {dragActive ? 'Drop image to attach' : (
            <>
              {uploadNote}
              {imageCount > 0 && (
                <span style={{ marginLeft: uploadNote ? 8 : 0 }}>
                  📎 {imageCount} image{imageCount === 1 ? '' : 's'} attached
                </span>
              )}
            </>
          )}
        </div>
      )}

      {/* input row (border + tint shift to accent while a file is dragged over) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 8,
          background: dragActive ? 'color-mix(in srgb, var(--acc) 10%, var(--elev))' : 'var(--elev)',
          border: dragActive ? '1px solid var(--acc)' : '1px solid var(--border)',
          borderRadius: 12,
          padding: '7px 8px 7px 9px',
          transition: 'border-color .12s, background .12s',
        }}
      >
        {/* attach → upload to inbox; images ride along with the next directive as a real block.
            Mobile: paperclip becomes a "+" flyout (Add file / Dictate). Desktop: unchanged. */}
        {isMobile ? (
          <InputActionsMenu
            onAddFile={() => fileInputRef.current?.click()}
            onDictate={() => void dictation.start()}
            dictateDisabled={!sttConfigured}
            dictateHint="Set up in Settings → Transcription"
            triggerStyle={{ width: 32, height: 32, borderRadius: 8, border: 'none', background: 'var(--hover, rgba(255,255,255,.05))' }}
          />
        ) : (
          <label
            title="Attach file"
            style={{ flex: 'none', width: 32, height: 32, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: 'var(--hover, rgba(255,255,255,.05))', color: 'var(--ts)' }}
          >
            <Paperclip size={16} />
            <input type="file" multiple style={{ display: 'none' }} onChange={(e) => { void attachFiles(e.target.files); e.currentTarget.value = ''; }} />
          </label>
        )}
        <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { void attachFiles(e.target.files); e.currentTarget.value = ''; }} />

        {/* autosizing textarea — swapped for the recording UI while dictating (mobile) */}
        {isMobile && dictation.state !== 'idle' ? (
          <DictationControl dictation={dictation} />
        ) : (
          <textarea
            ref={textareaRef}
            rows={1}
            value={composer}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={onPaste}
            placeholder={isMobile ? 'Fire a directive…' : 'Fire a directive to Dispatch…'}
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', resize: 'none', color: 'var(--tp)', fontSize: 13.5, lineHeight: 1.5, maxHeight: 120, padding: '7px 2px', fontFamily: 'inherit', overflow: 'auto' }}
          />
        )}

        {/* send → sendDirective */}
        <button
          onClick={handleSend}
          title="Send directive"
          style={{
            flex: 'none',
            width: 32,
            height: 32,
            borderRadius: 8,
            background: 'var(--acc)',
            color: '#06140B',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            border: 'none',
          }}
        >
          <Icon name="ph-paper-plane-right" weight="fill" size={16} />
        </button>
      </div>

      {/* hint row (spec §6: breathing dot · "Always listening…" · spacer · "⌘↵ send") */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          marginTop: 8,
        }}
      >
        <StatusDot
          color="var(--acc)"
          anim="breathe var(--pulse) ease-in-out infinite"
          size={6}
        />
        <span style={{ fontSize: 10.5, color: 'var(--tt)' }}>
          Always listening — capture is instant, never blocked by the work below
        </span>
        {!isMobile && (
          <>
            <span style={{ flex: 1 }} />
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                color: 'var(--tt)',
              }}
            >
              ⌘↵ send
            </span>
          </>
        )}
      </div>
    </div>
  );
}
