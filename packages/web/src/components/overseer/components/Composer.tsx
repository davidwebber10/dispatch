// Overseer view — "Always listening" directive composer (spec §6 "Composer", §7, §9).
//
// Layout: outer container (flex:none, border-top) > input row ("+" | textarea | send)
//         + hint row (breathing dot · "Always listening…" · spacer · "⌘↵ send").
// Store: composer, setComposer, sendDirective, openDelegate (no prop drilling).
// Interactions: ⌘/Ctrl+Enter → sendDirective; autosizing textarea (rows 1, max 120px).
// Mobile: shorter placeholder ("Fire a directive…"); hint row omits the keyboard hint.

import { useCallback, useRef, type KeyboardEvent } from 'react';
import { Icon, StatusDot } from '../atoms';
import { useOverseer } from '../store';
import { useIsMobile } from '../../../hooks/useIsMobile';

export function Composer() {
  const composer = useOverseer((s) => s.composer);
  const setComposer = useOverseer((s) => s.setComposer);
  const sendDirective = useOverseer((s) => s.sendDirective);
  const openDelegate = useOverseer((s) => s.openDelegate);
  const isMobile = useIsMobile();

  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
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

  return (
    <div
      style={{
        flex: 'none',
        borderTop: '1px solid var(--border)',
        padding: '12px 16px 13px',
        background: 'var(--base)',
      }}
    >
      {/* input row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 8,
          background: 'var(--elev)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: '7px 8px 7px 9px',
        }}
      >
        {/* "+" → openDelegate */}
        <button
          onClick={openDelegate}
          title="Delegate as a task"
          style={{
            flex: 'none',
            width: 31,
            height: 31,
            borderRadius: 8,
            background: 'var(--pane)',
            border: '1px solid var(--border)',
            color: 'var(--ts)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <Icon name="ph-plus" size={17} />
        </button>

        {/* autosizing textarea */}
        <textarea
          ref={textareaRef}
          rows={1}
          value={composer}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={isMobile ? 'Fire a directive…' : 'Fire a directive to the Overseer…'}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            resize: 'none',
            color: 'var(--tp)',
            fontSize: 13.5,
            lineHeight: 1.5,
            maxHeight: 120,
            padding: '7px 2px',
            fontFamily: 'inherit',
            overflow: 'auto',
          }}
        />

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
