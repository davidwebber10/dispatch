import { render, screen } from '@testing-library/react';
import { test, expect, describe, it } from 'vitest';
import { Modal } from './Modal';

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
