// The manual-override "escape hatch" for a wrong or stuck derived status — most acutely a
// thread left in Working by a daemon crash, which will never emit the event that would free
// it (see docs/superpowers/specs/2026-07-20-thread-board-design.md). A small "MOVE TO" popover
// offering exactly three targets: Needs Help / Complete / Resting, plus a separated Archive
// action below a divider.
//
// `Working` is deliberately NEVER offered. This is a design rule, not an omission: the other
// three are JUDGEMENTS the human is entitled to make ("this needs me", "this is done", "ignore
// this"). Working is an OBSERVED FACT — a thread is running or it is not, and asserting it does
// not start anything. Offering it would let someone paint a dead thread green and then wonder
// why nothing happens. The core route already rejects `working` with a 400 (see boardColumn.ts's
// OVERRIDE_TARGETS) — this component must not offer it in the first place.
//
// Visual reference: docs/design/board-redesign/Board mode redesign.dc.html's reasoning card
// "Move-to anchors down, ⋯ on hover, Archive back" (Open #3 / #8B), and the "complete card WITH
// move-to popover open" markup it points at. The panel chrome itself (background/border) uses
// the app-global var(--color-*) tokens, same pattern as InputActionsMenu.tsx's popover — the
// mockup's own literal panel colors were for a standalone static page, not this app's surfaces.
//
// Deliberately its OWN component rather than a BoardCard.tsx addition: a concurrent agent in
// this branch owns BoardCard.tsx/BoardCard.test.tsx. This wraps each card from the outside
// (mounted by BoardView.tsx and BoardMobile.tsx), leaving BoardCard itself untouched. Archive is
// called directly from here (api.archiveTerminal) rather than via a new prop threaded through
// BoardView/BoardMobile, for the same reason — this task's file scope is this component alone.
//
// Trigger placement: inner-top-right, immediately to the LEFT of where Complete's persistent ☐
// checkbox sits (the mockup's top-right control cluster: ⋯ then ☐, gap 8, both flush to the
// card's top-right corner). Using a fixed inset that clears a checkbox-sized control works for
// every column uniformly — needs_help/working/resting have nothing in that corner to begin
// with, so the same offset is simply unused space there. needs_help's Answer/Open/Dismiss
// buttons sit bottom-LEFT, nowhere near this.
//
// Hover reveal: the trigger fades in on hover for pointer-fine (mouse) input, matching the
// mockup's "no permanent footprint" framing. Devices with no hover capability (touch) get it
// always-visible instead — there is no hover gesture to reveal it with, so hiding it there would
// make it undiscoverable. jsdom has no matchMedia by default, which resolves to "no hover
// capability" here (same fallback idiom as usePrefersReducedMotion/useIsMobile use elsewhere in
// this codebase) — i.e. the trigger is always-visible, and hence always testable, under test.
//
// Popover direction: opens DOWNWARD by default, anchored just below the trigger, and only flips
// upward when downward would overflow the viewport's bottom edge. jsdom has no layout, so the
// actual measurement (getBoundingClientRect/window.innerHeight) only ever runs in a real
// browser; the decision itself is factored into the standalone, pure `decidePopoverDirection`
// below so it can be unit-tested without any of that.
//
// Mobile trigger is long-press. Rather than hand-rolling touch-timer bookkeeping (movement
// thresholds, cancel-on-scroll, etc), this relies on the browser's own long-press -> native
// `contextmenu` event, which is how mobile Safari/Chrome already signal a long-press on a touch
// target — `preventDefault()` on that event suppresses the native context menu in its favour.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { BoardColumn } from './boardColumn';
import { api } from '../../api/client';

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

// Fixed geometry the trigger lives at, and the numbers the popover positioning math is built
// from (see the header comment on why this needs no knowledge of the card's own height).
const TRIGGER_TOP = 8;
const TRIGGER_SIZE = 20;
// Clears a checkbox-sized (22px) control plus an 8px gap, flush to the card's right edge —
// mirrors the mockup's ⋯-then-☐ cluster order (see header comment on trigger placement).
const TRIGGER_RIGHT = 38;
const ANCHOR_GAP = 6;
const PANEL_RIGHT = 8;

export type PopoverDirection = 'down' | 'up';

interface AnchorRect {
  top: number;
  bottom: number;
}

/**
 * Pure positioning decision, deliberately factored out of the component so it is unit-testable
 * under jsdom (which has no real layout — getBoundingClientRect always returns zeroes there).
 * Opens downward whenever the panel fits in the space below the anchor; flips upward only when
 * it would overflow the viewport's bottom edge.
 */
export function decidePopoverDirection(
  anchorRect: AnchorRect,
  panelHeight: number,
  viewportHeight: number,
  gap: number = ANCHOR_GAP,
): PopoverDirection {
  const spaceBelow = viewportHeight - anchorRect.bottom - gap;
  return spaceBelow >= panelHeight ? 'down' : 'up';
}

const wrapStyle = {
  position: 'relative' as const,
};

// Opacity/transition are overridden per-instance by the hover/touch logic below; everything
// else here is shared.
const triggerButtonStyle = {
  position: 'absolute' as const,
  top: TRIGGER_TOP,
  right: TRIGGER_RIGHT,
  zIndex: 1,
  width: TRIGGER_SIZE,
  height: TRIGGER_SIZE,
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
  transition: 'opacity 120ms ease',
};

const panelBaseStyle = {
  position: 'absolute' as const,
  right: PANEL_RIGHT,
  zIndex: 20,
  minWidth: 152,
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

// Archive reads as a lesser-emphasis action than the three move targets above it — secondary
// text colour, same row shape — matching the mockup's own Archive row treatment.
const archiveButtonStyle = {
  ...rowButtonStyle,
  color: 'var(--color-text-secondary)',
};

const dividerStyle = {
  height: 1,
  background: 'var(--color-border)',
  margin: '5px 8px',
};

// Accepts both a button's onClick event and a div's onContextMenu event — both carry
// stopPropagation/preventDefault, which is all this needs. Kept as a plain structural type
// rather than importing React's MouseEvent so the wrapper works for either event source.
interface DismissableEvent {
  stopPropagation: () => void;
  preventDefault: () => void;
}

/** True on pointer-fine, hover-capable input (a mouse). False on touch AND wherever matchMedia
 * is unavailable (jsdom/SSR) — the same "absent means no" fallback idiom this codebase already
 * uses in useIsMobile/usePrefersReducedMotion, kept inline here since this task's file scope is
 * this component alone. */
function useCanHover(): boolean {
  const query = '(hover: hover) and (pointer: fine)';
  const [canHover, setCanHover] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const onChange = () => setCanHover(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return canHover;
}

export function MoveToMenu({ terminalId, onOverride, trigger = 'button', children }: MoveToMenuProps) {
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<PopoverDirection>('down');
  const [hovering, setHovering] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const canHover = useCanHover();

  // Closes on outside click — same pattern as InputActionsMenu.tsx's popover.
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  // Measures the real anchor + panel once the panel is in the DOM and decides whether it still
  // fits below, or must flip up — see decidePopoverDirection's own comment for why the decision
  // itself lives in a separate pure function. Runs in a layout effect so the flip (if any)
  // resolves before paint, with no visible flicker.
  useLayoutEffect(() => {
    if (!open) return;
    setDirection('down');
    const anchor = (triggerRef.current ?? wrapRef.current)?.getBoundingClientRect();
    const panelHeight = panelRef.current?.offsetHeight ?? 0;
    if (!anchor || typeof window === 'undefined') return;
    setDirection(decidePopoverDirection(anchor, panelHeight, window.innerHeight));
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

  const archive = () => {
    setOpen(false);
    void api.archiveTerminal(terminalId);
  };

  // Visible whenever this device has no hover to reveal it with (touch), or the card is
  // hovered/focused/already open on a device that does.
  const triggerVisible = !canHover || hovering || open;

  const panelStyle = {
    ...panelBaseStyle,
    ...(direction === 'down'
      ? { top: TRIGGER_TOP + TRIGGER_SIZE + ANCHOR_GAP }
      : { bottom: TRIGGER_TOP + TRIGGER_SIZE + ANCHOR_GAP }),
  };

  return (
    <div
      ref={wrapRef}
      data-testid="move-to-menu-wrap"
      style={wrapStyle}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      {...(trigger === 'longpress' ? { onContextMenu: openMenu } : {})}
    >
      {children}

      {trigger === 'button' && (
        <button
          ref={triggerRef}
          type="button"
          aria-label="Move to…"
          onClick={openMenu}
          style={{ ...triggerButtonStyle, opacity: triggerVisible ? 0.85 : 0 }}
        >
          ⋯
        </button>
      )}

      {open && (
        <div ref={panelRef} data-testid="move-to-menu" style={panelStyle}>
          <div style={{ fontSize: 9.5, letterSpacing: '.5px', opacity: 0.45, padding: '4px 12px 6px' }}>MOVE TO</div>
          {/* Scoped so tests (and any future reader) can distinguish "the three move targets"
              from Archive below — Archive is a different kind of act, not a fourth column, per
              the design's own framing (see file header). */}
          <div data-testid="move-to-targets">
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

          <div data-testid="move-to-menu-divider" role="separator" style={dividerStyle} />

          <button
            type="button"
            aria-label="Archive"
            style={archiveButtonStyle}
            onClick={(e) => {
              e.stopPropagation();
              archive();
            }}
          >
            <span aria-hidden="true">🗄</span> Archive
          </button>
        </div>
      )}
    </div>
  );
}
