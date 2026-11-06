import { useEffect, useLayoutEffect, useRef, type ReactNode, type Ref, type TextareaHTMLAttributes } from 'react';
import { ArrowUp, Microphone, Stop } from '@phosphor-icons/react';
import type { Dictation } from '../../hooks/useDictation';
import { DictationControl } from '../dictation/DictationControl';
import { InputActionsMenu } from '../dictation/InputActionsMenu';

/**
 * The one message composer (2026-11-05, modelled on ChatGPT's): a rounded box holding
 *   [+]  text that wraps and grows  [mic] [↑]
 * Every composer in the app renders this: a thread's CLI input on a phone, the Pretty thread
 * view, Control Plane and Chat. Each keeps its own sending, attachments and stop logic; this
 * owns only the look and the shared controls, so the four cannot drift apart again.
 *
 * - The + opens Add file, plus any host rows (Chat's Project).
 * - The text box grows one wrapped line at a time up to half the window, then scrolls.
 * - The mic starts dictation; the box shows the recording controls until it ends.
 * - The round ↑ sends. While a turn runs over an empty box it is a Stop.
 * - Return sends, Shift+Return is a new line, and Return during IME composition does nothing.
 */
export interface PillComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** False greys the ↑ out. Hosts count attachments as well as text. */
  canSend: boolean;
  stopMode?: boolean;
  onStop?: () => void;
  placeholder: string;
  onAddFile: () => void;
  /** Extra rows at the top of the + menu (Chat's project choice). */
  menuExtra?: (close: () => void) => ReactNode;
  dictation: Dictation;
  /** False shows the mic greyed out, pointing at Settings → Transcription. */
  sttConfigured: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>;
  /** Passed through to the text box: aria-label, onPaste, spell-check and capitalisation. */
  textareaProps?: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'placeholder' | 'rows' | 'style'>;
  /** Accent outline while a file is dragged over the host. */
  dragActive?: boolean;
  /** Mobile sizing: bigger touch targets. */
  mobile?: boolean;
  /** The ↑'s accessible name and tooltip (Control Plane: "Send directive"). */
  sendLabel?: string;
}

const MAX_FRACTION = 0.5;

export function PillComposer({
  value, onChange, onSend, canSend, stopMode = false, onStop, placeholder, onAddFile, menuExtra,
  dictation, sttConfigured, textareaRef, textareaProps, dragActive = false, mobile = false, sendLabel = 'Send',
}: PillComposerProps) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const key = mobile ? 36 : 32;
  const lineH = mobile ? 22 : 21;
  const minH = key;

  // Grow with the text, then scroll past half the window. Runs on every change, so a paste, a
  // draft restore, dictation and the clear after a send all resize it.
  const fit = () => {
    const el = own.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(minH, Math.min(el.scrollHeight, Math.round(window.innerHeight * MAX_FRACTION)))}px`;
  };
  useLayoutEffect(fit, [value, minH]);
  // A resize (rotation, the keyboard, a window drag) re-wraps the text and moves the cap.
  useEffect(() => {
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  });

  const setRef = (el: HTMLTextAreaElement | null) => {
    own.current = el;
    if (typeof textareaRef === 'function') textareaRef(el);
    else if (textareaRef) (textareaRef as { current: HTMLTextAreaElement | null }).current = el;
  };

  // Recording and transcribing take the text box's place. An error does not: it is a line above
  // the box (a long message squeezed in beside the keys wrapped into a column, 2026-11-05).
  const recording = dictation.state === 'recording' || dictation.state === 'transcribing';
  const failed = dictation.state === 'error';
  const circle = { flex: 'none', width: key, height: key, padding: 0, borderRadius: '50%', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' } as const;

  return (
    <>
    {failed && (
      <div role="alert" style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '0 6px 8px', fontSize: 13, lineHeight: 1.4 }}>
        <span style={{ flex: 1, minWidth: 0, color: 'var(--color-status-red)' }}>{dictation.error}</span>
        <button type="button" onClick={() => void dictation.start()} style={{ flex: 'none', padding: 0, background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 13 }}>Retry</button>
        <button type="button" onClick={dictation.reset} style={{ flex: 'none', padding: 0, background: 'none', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 13 }}>Dismiss</button>
      </div>
    )}
    <div data-testid="pill-composer" style={{
      display: 'flex', alignItems: 'flex-end', gap: 4, padding: 5, borderRadius: 'var(--radius-xl)', // the terminal card's radius, so the two line up
      background: dragActive ? 'color-mix(in srgb, var(--color-accent) 10%, var(--color-elevated))' : 'var(--color-elevated)',
      border: `1px solid ${dragActive ? 'var(--color-accent)' : 'var(--color-border)'}`, transition: 'border-color .12s, background .12s',
    }}>
      <InputActionsMenu
        onAddFile={onAddFile}
        extra={menuExtra}
        triggerStyle={{ ...circle, background: 'transparent', color: 'var(--color-text-primary)', cursor: 'pointer' }}
      />
      {recording ? (
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', minHeight: key }}><DictationControl dictation={dictation} /></div>
      ) : (
        <textarea
          {...textareaProps}
          ref={setRef}
          rows={1}
          value={value}
          placeholder={placeholder}
          enterKeyHint={textareaProps?.enterKeyHint ?? 'send'}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            textareaProps?.onKeyDown?.(e);
            if (e.defaultPrevented || e.nativeEvent.isComposing) return;
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (stopMode && !canSend) return; if (canSend) onSend(); }
          }}
          /* 16px on a phone: anything smaller makes iOS zoom the page on focus. */
          style={{
            flex: 1, minWidth: 0, minHeight: minH, height: minH, margin: 0, resize: 'none', overflowY: 'auto',
            border: 'none', outline: 'none', background: 'transparent', color: 'var(--color-text-primary)',
            font: `400 ${mobile ? 16 : 14.5}px var(--font-sans)`, lineHeight: `${lineH}px`,
            padding: `${(minH - lineH) / 2}px 4px`, boxSizing: 'border-box',
          }}
        />
      )}
      {!recording && (
        <button type="button" aria-label="Dictate" disabled={!sttConfigured}
          title={sttConfigured ? 'Dictate' : 'Dictation: set up in Settings → Transcription'}
          onMouseDown={(e) => e.preventDefault() /* keep the keyboard up */}
          onClick={() => void dictation.start()}
          style={{ ...circle, background: 'transparent', color: sttConfigured ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)', cursor: sttConfigured ? 'pointer' : 'default', opacity: sttConfigured ? 1 : 0.5 }}>
          <Microphone size={mobile ? 21 : 18} />
        </button>
      )}
      {stopMode ? (
        <button type="button" aria-label="Stop" title="Stop" onClick={onStop}
          style={{ ...circle, background: 'var(--color-text-primary)', color: 'var(--color-base)', cursor: 'pointer' }}>
          <Stop size={mobile ? 15 : 13} weight="fill" />
        </button>
      ) : (
        <button type="button" aria-label={sendLabel} title={sendLabel} disabled={!canSend}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onSend}
          style={{ ...circle, background: canSend ? 'var(--color-accent)' : 'var(--color-hover, rgba(255,255,255,.08))', color: canSend ? '#06140B' : 'var(--color-text-tertiary)', cursor: canSend ? 'pointer' : 'default', transition: 'background .15s' }}>
          <ArrowUp size={mobile ? 20 : 17} weight="bold" />
        </button>
      )}
    </div>
    </>
  );
}
