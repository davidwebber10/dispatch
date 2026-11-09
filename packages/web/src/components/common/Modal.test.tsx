import { useRef, useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { test, expect, describe, it, beforeEach, afterEach } from 'vitest';
import { Modal } from './Modal';

/** The sheet is the phone's (2026-11-07): its tests run at a phone's width. */
function phoneWidth(on: boolean) {
  const w = on ? 390 : 1024;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({ matches: w <= 768 && q.includes('max-width'), media: q, addEventListener: () => {}, removeEventListener: () => {} })) as any;
}

test('dialog is responsive (maxWidth, width 100%) so it fits a mobile viewport, not a fixed 500px that overflows', () => {
  render(<Modal open onClose={() => {}} title="New thing"><div>body</div></Modal>);
  const box = screen.getByText('New thing').parentElement as HTMLElement; // the dialog box wraps the title
  expect(box.style.width).toBe('100%');
  expect(box.style.maxWidth).toBe('500px');
});

test('renders nothing when closed', () => {
  const { container } = render(<Modal open={false} onClose={() => {}} title="T"><div /></Modal>);
  expect(container.firstChild).toBeNull();
});

// Regression: on a phone a tall modal (the new-thread form) could not be scrolled —
// it just stuck. Two causes, both pure CSS on this shared shell:
//
//  1. the panel was clamped to `maxHeight: calc(100dvh - 32px)`, but `dvh` does NOT
//     shrink for the on-screen keyboard, so once the keyboard was up the bottom of
//     the modal sat under it with no overflow left to scroll; and
//  2. the backdrop centred with `align-items:center`, which distributes overflow to
//     BOTH sides — so a modal taller than the viewport had its top half pushed above
//     the scroll origin, permanently out of reach.
//
// The fix moves scrolling to the backdrop and centres the panel with `margin:auto`,
// which collapses to zero when there is no free space (top-aligned, fully scrollable)
// and centres when there is.
describe('Modal — scroll and alignment', () => {
  function renderModal() {
    render(<Modal open onClose={() => {}} title="New Thread"><div>body</div></Modal>);
    const panel = screen.getByText('New Thread').parentElement as HTMLElement;
    return { panel, backdrop: panel.parentElement as HTMLElement };
  }

  it('scrolls on the backdrop, not the panel', () => {
    const { backdrop, panel } = renderModal();
    expect(backdrop.style.overflowY).toBe('auto');
    expect(panel.style.overflowY).toBe('');
  });

  it('leaves the panel unclamped so tall content is never stranded under the keyboard', () => {
    const { panel } = renderModal();
    expect(panel.style.maxHeight).toBe('');
    // Without this a flex child is compressed instead of overflowing, which would
    // reintroduce the clipping from the other direction.
    expect(panel.style.flexShrink).toBe('0');
  });

  it('top-aligns when tall and centres when short, via auto margins', () => {
    const { backdrop, panel } = renderModal();
    expect(backdrop.style.alignItems).toBe('flex-start');
    expect(panel.style.margin).toBe('auto');
  });

  it('keeps the scroll gesture from chaining to the page behind it', () => {
    expect(renderModal().backdrop.style.overscrollBehavior).toBe('contain');
  });
});

describe('Modal — title-less and sheet variants', () => {
  beforeEach(() => phoneWidth(true));
  afterEach(() => phoneWidth(false));
  it('renders no heading when no title is given', () => {
    render(<Modal open onClose={() => {}}><div>body</div></Modal>);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('as a sheet: full width, anchored to the bottom via marginTop:auto, with a drag handle', () => {
    render(<Modal open onClose={() => {}} sheet><div>body</div></Modal>);
    const panel = screen.getByText('body').parentElement as HTMLElement;
    expect(screen.getByTestId('sheet-handle')).toBeInTheDocument();
    expect(panel.style.width).toBe('100%');
    expect(panel.style.maxWidth).toBe('');
    expect(panel.style.marginTop).toBe('auto');
    expect(panel.style.borderRadius).toBe('var(--radius-2xl) var(--radius-2xl) 0 0'); // the shared radius scale (theme.css)
    // Same scroll contract as the card: the backdrop scrolls, the panel is unclamped.
    const backdrop = panel.parentElement as HTMLElement;
    expect(backdrop.style.overflowY).toBe('auto');
    expect(panel.style.maxHeight).toBe('');
    expect(panel.style.flexShrink).toBe('0');
  });
});

describe('Modal — anchor', () => {
  it('anchor="top" pins the card under a fixed top inset so a height change only moves its bottom edge', () => {
    render(<Modal open onClose={() => {}} anchor="top"><div>body</div></Modal>);
    const panel = screen.getByText('body').parentElement as HTMLElement;
    const backdrop = panel.parentElement as HTMLElement;
    expect(panel.style.marginTop).toBe('0px');
    expect(panel.style.marginBottom).toBe('auto');
    expect(backdrop.style.paddingTop).toContain('12vh');
  });

  it('defaults to centring via auto margins', () => {
    render(<Modal open onClose={() => {}}><div>body</div></Modal>);
    const panel = screen.getByText('body').parentElement as HTMLElement;
    expect(panel.style.margin).toBe('auto');
  });
});

// Regression: on an iPhone the Projects sheet could not be closed. The handle was
// decoration, the only exit was the backdrop strip, and a tall list left none.
describe('Modal sheet: always closable', () => {
  beforeEach(() => phoneWidth(true));
  afterEach(() => phoneWidth(false));
  // jsdom has no PointerEvent, so fireEvent would drop clientY and pointerId.
  if (typeof window.PointerEvent === 'undefined') {
    class PointerEventShim extends MouseEvent {
      pointerId: number; isPrimary: boolean;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0; this.isPrimary = init.isPrimary ?? true;
      }
    }
    (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventShim;
  }
  function renderSheet(onClose = vi.fn(), title: string | undefined = 'Projects', props: { closeButton?: boolean } = {}) {
    render(<Modal open onClose={onClose} title={title} sheet {...props}><div>body</div></Modal>);
    const handle = screen.getByTestId('sheet-handle');
    const panel = screen.getByTestId('sheet-panel') as HTMLElement;
    Object.defineProperty(panel, 'offsetHeight', { value: 400, configurable: true });
    return { onClose, handle, panel, header: screen.getByTestId('sheet-header') };
  }
  // The component times gestures with performance.now(); drive it by hand so velocity is deterministic.
  let clock = 0;
  beforeEach(() => { clock = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock); });
  afterEach(() => { vi.restoreAllMocks(); });
  const at = (t: number) => { clock = t; };
  const down = (el: Element, y: number, t = 0) => { at(t); fireEvent.pointerDown(el, { pointerId: 1, clientY: y, isPrimary: true }); };
  const move = (el: Element, y: number, t: number) => { at(t); fireEvent.pointerMove(el, { pointerId: 1, clientY: y }); };
  const up = (el: Element, y: number, t: number) => { at(t); fireEvent.pointerUp(el, { pointerId: 1, clientY: y }); };

  it('shows a 44pt Close button in the header that closes the sheet', () => {
    const { onClose } = renderSheet();
    const btn = screen.getByRole('button', { name: 'Close' });
    expect(btn.style.minWidth).toBe('44px');
    expect(btn.style.minHeight).toBe('44px');
    fireEvent.click(btn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the Close button on a title-less sheet too, without an empty heading', () => {
    render(<Modal open onClose={() => {}} sheet><div>b</div></Modal>);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('desktop (non-sheet) modal has no Close button and no sheet panel', () => {
    render(<Modal open onClose={() => {}} title="T"><div /></Modal>);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(screen.queryByTestId('sheet-panel')).toBeNull();
  });

  it('Escape closes the sheet', () => {
    const { onClose } = renderSheet();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps a dimmed strip above the sheet: the backdrop top padding is at least 48px', () => {
    const { panel } = renderSheet();
    expect((panel.parentElement as HTMLElement).style.paddingTop).toContain('48px');
  });

  it('keeps the header sticky so Close and the handle stay reachable in a scrolled tall sheet', () => {
    const { header } = renderSheet();
    expect(header.style.position).toBe('sticky');
    expect(header.style.top).toContain('safe-area-inset-top');
  });

  it('dragging the handle down follows the finger', () => {
    const { handle, panel } = renderSheet();
    down(handle, 100, 0); move(handle, 160, 500);
    expect(panel.style.transform).toBe('translateY(60px)');
  });

  it('never moves above its rest position when dragged up', () => {
    const { handle, panel } = renderSheet();
    down(handle, 100, 0); move(handle, 40, 100);
    expect(panel.style.transform).toBe('translateY(0px)');
  });

  it('closes when released past 25% of the sheet height', () => {
    const { handle, onClose } = renderSheet();
    down(handle, 100, 0); move(handle, 210, 800); up(handle, 210, 800);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a fast downward flick even over a short distance', () => {
    const { handle, onClose } = renderSheet();
    down(handle, 100, 0); move(handle, 140, 40); up(handle, 140, 50);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('springs back (no close) on a short, slow drag', () => {
    const { handle, panel, onClose } = renderSheet();
    down(handle, 100, 0); move(handle, 130, 900); up(handle, 130, 1000);
    expect(onClose).not.toHaveBeenCalled();
    expect(panel.style.transform).toBe('translateY(0px)');
  });

  it('drags from the header title area as well as the handle', () => {
    const { header, onClose } = renderSheet();
    down(header, 100, 0); move(header, 250, 700); up(header, 250, 700);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not start a drag from the body, so the list can scroll', () => {
    const { onClose, panel } = renderSheet();
    const body = screen.getByText('body');
    down(body, 100, 0); move(body, 400, 100); up(body, 400, 100);
    expect(onClose).not.toHaveBeenCalled();
    expect(panel.style.transform).not.toContain('300');
  });

  it('the drag zone disables native touch panning so the browser does not steal the gesture', () => {
    const { header } = renderSheet();
    expect(header.style.touchAction).toBe('none');
  });

  it('a tap on the Close button is not swallowed by the header drag', () => {
    const { onClose } = renderSheet();
    const btn = screen.getByRole('button', { name: 'Close' });
    down(btn, 100, 0); up(btn, 100, 10); fireEvent.click(btn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closeButton={false} drops the header row entirely (the caller has its own Close)', () => {
    render(<Modal open onClose={() => {}} sheet closeButton={false}><div>b</div></Modal>);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(screen.getByTestId('sheet-handle')).toBeInTheDocument();
  });

  it('a drag-close leaves no offset behind when the same mounted Modal reopens', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Modal open onClose={onClose} title="P" sheet><div>b</div></Modal>);
    const handle = screen.getByTestId('sheet-handle');
    Object.defineProperty(screen.getByTestId('sheet-panel'), 'offsetHeight', { value: 400, configurable: true });
    down(handle, 100, 0); move(handle, 300, 800); up(handle, 300, 800);
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<Modal open={false} onClose={onClose} title="P" sheet><div>b</div></Modal>);
    rerender(<Modal open onClose={onClose} title="P" sheet><div>b</div></Modal>);
    expect(screen.getByTestId('sheet-panel').style.transform).toBe('translateY(0px)');
  });

  it('a pause before release is not a flick', () => {
    const { handle, onClose } = renderSheet();
    down(handle, 100, 0); move(handle, 140, 40); up(handle, 140, 2000);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape already consumed by an inner layer (a lightbox) does not close the sheet', () => {
    const { onClose } = renderSheet();
    const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    ev.preventDefault();
    document.dispatchEvent(ev);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not capture the pointer when the press starts on the Close button', () => {
    const { header } = renderSheet();
    const spy = vi.fn();
    (header as unknown as { setPointerCapture: unknown }).setPointerCapture = spy;
    down(screen.getByRole('button', { name: 'Close' }), 100, 0);
    expect(spy).not.toHaveBeenCalled();
    down(header, 100, 0);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // Pull to close (2026-11-06): at the top of its scroll, pulling the content down moves the sheet.
  const tStart = (el: Element, y: number, t = 0) => { at(t); fireEvent.touchStart(el, { touches: [{ clientY: y }] }); };
  const tMove = (el: Element, y: number, t: number) => { at(t); fireEvent.touchMove(el, { touches: [{ clientY: y }] }); };
  const tEnd = (el: Element, t: number) => { at(t); fireEvent.touchEnd(el, { touches: [] }); };

  it('pulling the content down at the top of the scroll moves the sheet, and a long pull closes it', () => {
    const { panel, onClose } = renderSheet();
    const body = screen.getByText('body');
    tStart(body, 100, 0); tMove(body, 120, 100); tMove(body, 180, 400);
    expect(panel.style.transform).toBe('translateY(80px)');
    tMove(body, 260, 900); tEnd(body, 1000);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a short, slow pull springs back', () => {
    const { panel, onClose } = renderSheet();
    const body = screen.getByText('body');
    tStart(body, 100, 0); tMove(body, 130, 600); tEnd(body, 1200);
    expect(onClose).not.toHaveBeenCalled();
    expect(panel.style.transform).toBe('translateY(0px)');
  });

  it('a list scrolled down scrolls as usual: no pull until it is back at the top', () => {
    const { panel } = renderSheet();
    const backdrop = panel.parentElement as HTMLElement;
    backdrop.scrollTop = 200;
    const body = screen.getByText('body');
    tStart(body, 100, 0); tMove(body, 180, 100);
    expect(panel.style.transform).toBe('translateY(0px)');
    backdrop.scrollTop = 0; // the scroll reached the top mid-gesture: the pull starts from where the finger was (180)
    tMove(body, 200, 200); tMove(body, 240, 300);
    expect(panel.style.transform).toBe('translateY(60px)');
  });

  it('pulling up never moves the sheet', () => {
    const { panel } = renderSheet();
    const body = screen.getByText('body');
    tStart(body, 300, 0); tMove(body, 200, 100);
    expect(panel.style.transform).toBe('translateY(0px)');
  });
});

describe('a sheet is a phone thing: the desktop gets a centered modal (2026-11-07)', () => {
  const setWidth = (w: number) => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: w }); window.matchMedia = vi.fn().mockImplementation((q: string) => ({ matches: w <= 768 && q.includes('max-width'), media: q, addEventListener: () => {}, removeEventListener: () => {} })) as any; };
  afterEach(() => setWidth(1024));
  it('on the desktop, `sheet` renders the centered card with its title, a Close button and Escape', () => {
    setWidth(1440);
    const onClose = vi.fn();
    render(<Modal open sheet title="Choose a theme" onClose={onClose}><div>body</div></Modal>);
    expect(screen.queryByTestId('sheet-panel')).toBeNull();
    expect(screen.queryByTestId('sheet-handle')).toBeNull();
    const dialog = screen.getByRole('dialog', { name: 'Choose a theme' });
    expect(dialog.style.maxWidth).toBe('500px');
    expect(dialog.style.width).toBe('100%');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
  it('on a phone, `sheet` is still the bottom sheet', () => {
    setWidth(390);
    render(<Modal open sheet title="Choose a theme" onClose={() => {}}><div>body</div></Modal>);
    expect(screen.getByTestId('sheet-panel')).toBeInTheDocument();
  });
});

// Keyboard and screen-reader behaviour (engineering program 2026-11-09, W3-E).
describe('Modal — focus and keyboard', () => {
  function Opener({ sheet = false, titled = true }) {
    const title = titled ? 'Rename thread' : undefined;
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open it</button>
        <button>Other page control</button>
        <Modal open={open} onClose={() => setOpen(false)} title={title} sheet={sheet}>
          <input aria-label="Name" />
          <button>Cancel</button>
          <button>Save</button>
        </Modal>
      </>
    );
  }
  const open = () => { const b = screen.getByText('Open it'); b.focus(); fireEvent.click(b); return b; };

  beforeEach(() => phoneWidth(false));

  it('has role dialog and aria-modal', () => {
    render(<Opener />);
    open();
    const dialog = screen.getByRole('dialog', { name: 'Rename thread' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // A labelled title: the dialog's name is the visible heading.
    const heading = screen.getByRole('heading', { name: 'Rename thread' });
    expect(dialog.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(heading.id).not.toBe('');
  });

  it('moves focus into the dialog when it opens', () => {
    render(<Opener />);
    open();
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('keeps a field that takes focus itself', () => {
    render(<Modal open onClose={() => {}} title="T"><input aria-label="Name" autoFocus /><button>Save</button></Modal>);
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  });

  it('Tab from the last control goes to the first', () => {
    render(<Opener />);
    open();
    const first = screen.getByLabelText('Name');
    const last = screen.getByText('Save');
    last.focus();
    const ev = fireEvent.keyDown(last, { key: 'Tab' });
    expect(ev).toBe(false); // the browser's own move is stopped
    expect(document.activeElement).toBe(first);
  });

  it('Shift+Tab from the first control goes to the last', () => {
    render(<Opener />);
    open();
    const first = screen.getByLabelText('Name');
    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText('Save'));
  });

  it('Tab from the dialog itself, or from outside it, goes to the first control', () => {
    render(<Opener />);
    open();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
    const outside = screen.getByText('Other page control');
    outside.focus();
    fireEvent.keyDown(outside, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  });

  it('a Tab in the middle is left to the browser', () => {
    render(<Opener />);
    open();
    const mid = screen.getByText('Cancel');
    mid.focus();
    expect(fireEvent.keyDown(mid, { key: 'Tab' })).toBe(true);
    expect(document.activeElement).toBe(mid);
  });

  it('focus returns to the opener', () => {
    render(<Opener />);
    const opener = open();
    screen.getByText('Save').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('does not take focus back from a control the app focused on close', () => {
    function Picker() {
      const [open, setOpen] = useState(false);
      const field = useRef<HTMLInputElement>(null);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open it</button>
          <input aria-label="Composer" ref={field} />
          <Modal open={open} onClose={() => setOpen(false)} title="Commands">
            <button onClick={() => { field.current?.focus(); setOpen(false); }}>Pick</button>
          </Modal>
        </>
      );
    }
    render(<Picker />);
    open();
    fireEvent.click(screen.getByText('Pick'));
    expect(document.activeElement).toBe(screen.getByLabelText('Composer'));
  });

  it('Escape closes a card, not only a sheet', () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="T"><button>Save</button></Modal>);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes only the dialog on top', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    function Two() {
      const [confirm, setConfirm] = useState(true);
      return (
        <Modal open onClose={outer} title="Outer">
          <button>Outer control</button>
          <Modal open={confirm} onClose={() => { inner(); setConfirm(false); }} title="Inner"><button>Inner control</button></Modal>
        </Modal>
      );
    }
    render(<Two />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape to a menu that already handled it', () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="T"><input aria-label="Search" onKeyDown={(e) => { if (e.key === 'Escape') e.preventDefault(); }} /></Modal>);
    fireEvent.keyDown(screen.getByLabelText('Search'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('an untitled dialog is still a dialog, and the Close control is a labelled button', () => {
    render(<Opener sheet titled={false} />);
    open();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).not.toHaveAttribute('aria-labelledby');
    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass('ui-icon-btn');
  });

  it('takes its layer from the layer token, not a literal', () => {
    render(<Opener />);
    open();
    const backdrop = screen.getByRole('dialog').parentElement as HTMLElement;
    expect(backdrop.style.zIndex).toBe('var(--z-overlay)');
  });
});
