import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type TextareaHTMLAttributes } from 'react';
import { ArrowUp, Microphone, Stop } from '@phosphor-icons/react';
import type { Dictation } from '../../hooks/useDictation';
import { DictationControl } from '../dictation/DictationControl';
import { InputActionsMenu } from '../dictation/InputActionsMenu';
import { useUI } from '../../stores/ui';

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
  // 60 px tall on a phone (2026-11-06, was 48): 42 px keys inside 8 px padding and a 1 px border.
  const key = mobile ? 42 : 32;
  const lineH = mobile ? 22 : 21;
  const minH = key;

  // Grow with the text, then scroll past half the window. Runs on every change, so a paste, a
  // draft restore, dictation and the clear after a send all resize it.
  const fit = () => {
    const el = own.current;
    if (!el) return;
    // Empty: one line, whatever the placeholder does (a long one wrapped and grew the box, 2026-11-06).
    if (!el.value) { el.style.height = `${minH}px`; return; }
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
  // Once there is text, it gets its own full-width line above the + / mic / send row (2026-11-05:
  // inline, a wrapped message sat between the keys with an odd uneven margin). One grid with
  // named areas, so the text box stays the same element when the layout switches (no lost focus).
  // Typing moves the text onto its own full-width line; dictation stays on one row (2026-11-06):
  // the recording bar takes the text and mic slots between + and send.
  const stacked = value.length > 0 && !recording;

  // Going to two lines (or back) glides instead of jumping (2026-11-06). A grid's layout can't be
  // transitioned in CSS, so each piece is measured every render; when the layout switches, the
  // pieces start where they were and slide to their new places, and the box grows to its new height.
  const boxRef = useRef<HTMLDivElement | null>(null);
  const was = useRef<{ stacked: boolean; height: number; rects: Map<Element, DOMRect> } | null>(null);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const rects = new Map<Element, DOMRect>();
    for (const el of Array.from(box.children)) rects.set(el, el.getBoundingClientRect());
    const height = box.getBoundingClientRect().height;
    const prev = was.current;
    was.current = { stacked, height, rects };
    if (!prev || prev.stacked === stacked || typeof box.animate !== 'function') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const timing = { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' };
    for (const [el, now] of rects) {
      const then = prev.rects.get(el);
      if (!then) continue;
      const dx = then.left - now.left, dy = then.top - now.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      (el as HTMLElement).animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], timing);
    }
    if (Math.abs(prev.height - height) >= 0.5) box.animate([{ height: `${prev.height}px` }, { height: `${height}px` }], timing);
  });
  // A mic with dictation not set up says so, with a link to the setting, instead of doing nothing.
  const [micHint, setMicHint] = useState(false);

  return (
    <>
    {micHint && !sttConfigured && (
      <div role="note" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 6px 8px', fontSize: 13 }}>
        <span style={{ flex: 1, minWidth: 0, color: 'var(--color-text-secondary)' }}>Dictation isn't set up yet.</span>
        <button type="button" onClick={() => { setMicHint(false); useUI.getState().requestSettings('transcription'); }} style={{ flex: 'none', padding: 0, background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 13 }}>Set up</button>
        <button type="button" onClick={() => setMicHint(false)} style={{ flex: 'none', padding: 0, background: 'none', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 13 }}>Dismiss</button>
      </div>
    )}
    {failed && (
      <div role="alert" style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '0 6px 8px', fontSize: 13, lineHeight: 1.4 }}>
        <span style={{ flex: 1, minWidth: 0, color: 'var(--color-status-red)' }}>{dictation.error}</span>
        <button type="button" onClick={() => void dictation.start()} style={{ flex: 'none', padding: 0, background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 13 }}>Retry</button>
        <button type="button" onClick={dictation.reset} style={{ flex: 'none', padding: 0, background: 'none', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 13 }}>Dismiss</button>
      </div>
    )}
    <div ref={boxRef} data-testid="pill-composer" data-stacked={stacked || undefined} style={{
      display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', alignItems: 'end', columnGap: 4, rowGap: 2,
      gridTemplateAreas: stacked ? '"text text text text" "plus . mic send"' : recording ? '"plus text text send"' : '"plus text mic send"',
      padding: mobile ? 8 : 5, borderRadius: 'var(--radius-xl)', // the terminal card's radius, so the two line up
      background: dragActive ? 'color-mix(in srgb, var(--color-accent) 10%, var(--color-elevated))' : 'var(--color-elevated)',
      border: `1px solid ${dragActive ? 'var(--color-accent)' : 'var(--color-border)'}`, transition: 'border-color .12s, background .12s',
    }}>
      <div style={{ gridArea: 'plus' }}>
        <InputActionsMenu
          onAddFile={onAddFile}
          extra={menuExtra}
          triggerStyle={{ ...circle, background: 'transparent', color: 'var(--color-text-primary)', cursor: 'pointer' }}
        />
      </div>
      {recording ? (
        <div style={{ gridArea: 'text', minWidth: 0, display: 'flex', alignItems: 'center', minHeight: key, padding: '0 4px' }}><DictationControl dictation={dictation} /></div>
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
            gridArea: 'text', width: '100%', minWidth: 0, minHeight: minH, height: minH, margin: 0, resize: 'none', overflowY: 'auto',
            border: 'none', outline: 'none', background: 'transparent', color: 'var(--color-text-primary)',
            font: `400 ${mobile ? 16 : 14.5}px var(--font-sans)`, lineHeight: `${lineH}px`,
            padding: stacked ? `${(minH - lineH) / 2}px 8px 2px` : `${(minH - lineH) / 2}px 4px`, boxSizing: 'border-box',
          }}
        />
      )}
      {!recording && (
        <button type="button" aria-label="Dictate"
          title={sttConfigured ? 'Dictate' : 'Dictation: set up in Settings → Transcription'}
          onMouseDown={(e) => e.preventDefault() /* keep the keyboard up */}
          onClick={() => { if (sttConfigured) void dictation.start(); else setMicHint((v) => !v); }}
          style={{ ...circle, gridArea: 'mic', background: 'transparent', color: sttConfigured ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)', cursor: 'pointer', opacity: sttConfigured ? 1 : 0.5 }}>
          <Microphone size={mobile ? 21 : 18} />
        </button>
      )}
      {stopMode ? (
        <button type="button" aria-label="Stop" title="Stop" onClick={onStop}
          style={{ ...circle, gridArea: 'send', background: 'var(--color-text-primary)', color: 'var(--color-base)', cursor: 'pointer' }}>
          <Stop size={mobile ? 15 : 13} weight="fill" />
        </button>
      ) : (
        <button type="button" aria-label={sendLabel} title={sendLabel} disabled={!canSend}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onSend}
          style={{ ...circle, gridArea: 'send', background: canSend ? 'var(--color-accent)' : 'var(--color-hover, rgba(255,255,255,.08))', color: canSend ? '#06140B' : 'var(--color-text-tertiary)', cursor: canSend ? 'pointer' : 'default', transition: 'background .15s' }}>
          <ArrowUp size={mobile ? 20 : 17} weight="bold" />
        </button>
      )}
    </div>
    </>
  );
}
