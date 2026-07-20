// The manual-override "escape hatch" for a wrong or stuck derived status — most acutely a
// thread left in Working by a daemon crash, which will never emit the event that would free
// it (see docs/superpowers/specs/2026-07-20-thread-board-design.md). A small "MOVE TO" popover
// offering exactly three targets: Needs Help / Complete / Resting.
//
// `Working` is deliberately NEVER offered. This is a design rule, not an omission: the other
// three are JUDGEMENTS the human is entitled to make ("this needs me", "this is done", "ignore
// this"). Working is an OBSERVED FACT — a thread is running or it is not, and asserting it does
// not start anything. Offering it would let someone paint a dead thread green and then wonder
// why nothing happens. The core route already rejects `working` with a 400 (see boardColumn.ts's
// OVERRIDE_TARGETS) — this component must not offer it in the first place.
//
// Visual reference: .superpowers/brainstorm/65628-1784514698/content/override.html's "MOVE TO"
// panel — a small header plus three rows, each with its column's colour dot (needs-help #e8b04b,
// complete #5A8DD6, resting muted via opacity). The panel chrome itself (background/border) uses
// the app-global var(--color-*) tokens, same pattern as InputActionsMenu.tsx's popover — the
// mockup's own literal panel colors were for a standalone static page, not this app's surfaces.
//
// Deliberately its OWN component rather than a BoardCard.tsx addition: a concurrent agent in
// this branch owns BoardCard.tsx/BoardCard.test.tsx. This wraps each card from the outside
// (mounted by BoardView.tsx and BoardMobile.tsx), leaving BoardCard itself untouched.
//
// Trigger placement: the mockup only shows the popover already open, not where its trigger
// lives on a card, so there is no literal reference for this. Bottom-right was chosen because
// it is the one corner that is empty across every column's own BoardCard content: needs_help's
// Answer/Open/Dismiss buttons sit bottom-LEFT (they start from the content's left edge),
// complete's Acknowledge checkbox sits TOP-right (alignSelf: flex-start), and working/resting
// have no buttons at all. This is a genuine visual judgement call, flagged in the task report.
//
// Mobile trigger is long-press. Rather than hand-rolling touch-timer bookkeeping (movement
// thresholds, cancel-on-scroll, etc), this relies on the browser's own long-press -> native
// `contextmenu` event, which is how mobile Safari/Chrome already signal a long-press on a touch
// target — `preventDefault()` on that event suppresses the native context menu in its favour.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { BoardColumn } from './boardColumn';

// 'working' excluded on purpose — see the file header. Keeping this type derived from
// BoardColumn (rather than hand-writing a separate union) means a future column rename can't
// silently drift the two apart.
export type OverrideTarget = Exclude<BoardColumn, 'working'>;

const TARGETS: { target: OverrideTarget; label: string; dotStyle: { color?: string; opacity?: number } }[] = [
  { target: 'needs_help', label: 'Needs help', dotStyle: { color: '#e8b04b' } },
  { target: 'complete', label: 'Complete', dotStyle: { color: '#5A8DD6' } },
  { target: 'resting', label: 'Resting', dotStyle: { opacity: 0.6 } },
];

export interface MoveToMenuProps {
  terminalId: string;
  onOverride: (terminalId: string, target: OverrideTarget) => void;
  /** 'button' renders a visible ⋯ trigger (desktop). 'longpress' renders no extra chrome and
   * opens on the wrapped card's long-press / contextmenu (mobile). Default 'button'. */
  trigger?: 'button' | 'longpress';
  children: ReactNode;
}

const triggerButtonStyle = {
  position: 'absolute' as const,
  bottom: 6,
  right: 6,
  zIndex: 1,
  width: 20,
  height: 20,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--color-elevated)',
  color: 'var(--color-text-secondary)',
  borderWidth: 1,
  borderStyle: 'solid' as const,
  borderColor: 'var(--color-border)',
  borderRadius: 5,
  cursor: 'pointer',
  fontSize: 12,
  lineHeight: 1,
  padding: 0,
  opacity: 0.7,
};

const panelStyle = {
  position: 'absolute' as const,
  bottom: 30,
  right: 6,
  zIndex: 20,
  minWidth: 148,
  background: 'var(--color-elevated)',
  color: 'var(--color-text-primary)',
  borderWidth: 1,
  borderStyle: 'solid' as const,
  borderColor: 'var(--color-border)',
  borderRadius: 9,
  overflow: 'hidden',
  boxShadow: '0 12px 34px -10px rgba(0,0,0,.7)',
  padding: '7px 0',
};

const rowButtonStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '8px 12px',
  background: 'none',
  border: 'none',
  textAlign: 'left' as const,
  fontSize: 12,
  color: 'var(--color-text-primary)',
  cursor: 'pointer',
};

// Accepts both a button's onClick event and a div's onContextMenu event — both carry
// stopPropagation/preventDefault, which is all this needs. Kept as a plain structural type
// rather than importing React's MouseEvent so the wrapper works for either event source.
interface DismissableEvent {
  stopPropagation: () => void;
  preventDefault: () => void;
}

export function MoveToMenu({ terminalId, onOverride, trigger = 'button', children }: MoveToMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Closes on outside click — same pattern as InputActionsMenu.tsx's popover.
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const openMenu = (e: DismissableEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(true);
  };

  const choose = (target: OverrideTarget) => {
    setOpen(false);
    onOverride(terminalId, target);
  };

  return (
    <div
      ref={wrapRef}
      data-testid="move-to-menu-wrap"
      style={{ position: 'relative' }}
      {...(trigger === 'longpress' ? { onContextMenu: openMenu } : {})}
    >
      {children}

      {trigger === 'button' && (
        <button type="button" aria-label="Move to…" onClick={openMenu} style={triggerButtonStyle}>
          ⋯
        </button>
      )}

      {open && (
        <div data-testid="move-to-menu" style={panelStyle}>
          <div style={{ fontSize: 9.5, letterSpacing: '.5px', opacity: 0.45, padding: '4px 12px 6px' }}>MOVE TO</div>
          {TARGETS.map(({ target, label, dotStyle }) => (
            <button
              key={target}
              type="button"
              aria-label={label}
              style={rowButtonStyle}
              onClick={(e) => {
                e.stopPropagation();
                choose(target);
              }}
            >
              <span aria-hidden="true" style={dotStyle}>◆</span> {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
