import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useRef, useState } from 'react';
import { Popover, placePopover } from './Popover';

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

function setViewport(w: number, h: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
}

function Harness({ onClose = () => {}, anchorRect = rect(100, 100, 80, 30) }: { onClose?: () => void; anchorRect?: DOMRect }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  return (
    <>
      <button ref={(el) => { (ref as { current: HTMLButtonElement | null }).current = el; if (el) el.getBoundingClientRect = () => anchorRect; }} onClick={() => setOpen(true)}>Open</button>
      <button>Elsewhere</button>
      <Popover open={open} anchor={ref} label="Details" onClose={() => { onClose(); setOpen(false); }}>
        <button>Inside</button>
      </Popover>
    </>
  );
}

afterEach(() => { vi.restoreAllMocks(); setViewport(1024, 768); });

describe('placePopover', () => {
  const view = { width: 1024, height: 768 };
  it('opens under the anchor, left edges in line', () => {
    expect(placePopover(rect(100, 100, 80, 30), { width: 240, height: 200 }, view)).toMatchObject({ left: 100, top: 136 });
  });
  it('stays inside the viewport near the right edge', () => {
    const p = placePopover(rect(980, 100, 36, 30), { width: 240, height: 200 }, view);
    expect(p.left + 240).toBeLessThanOrEqual(1024 - 8);
    expect(p.left).toBeGreaterThanOrEqual(8);
  });
  it('opens above the anchor when there is no room under it', () => {
    const p = placePopover(rect(100, 700, 80, 30), { width: 240, height: 200 }, view);
    expect(p.top + 200).toBeLessThanOrEqual(700);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });
  it('never leaves the top or the left edge, and caps its height to the viewport', () => {
    const p = placePopover(rect(-50, 300, 20, 20), { width: 240, height: 2000 }, view);
    expect(p.left).toBe(8);
    expect(p.top).toBe(8);
    expect(p.maxHeight).toBe(768 - 16);
  });
  it('bottom-end lines up the right edges', () => {
    expect(placePopover(rect(500, 100, 80, 30), { width: 240, height: 100 }, view, 'bottom-end').left).toBe(340);
  });
});

describe('Popover', () => {
  it('stays inside the viewport near the right edge', () => {
    setViewport(1024, 768);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(240);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200);
    render(<Harness anchorRect={rect(980, 100, 36, 30)} />);
    const pop = screen.getByRole('dialog', { name: 'Details' });
    expect(pop.style.position).toBe('fixed');
    const left = parseFloat(pop.style.left);
    expect(left + 240).toBeLessThanOrEqual(1024 - 8);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(parseFloat(pop.style.top)).toBe(136);
  });

  it('uses the dropdown layer token through its class, and renders in the body', () => {
    render(<Harness />);
    const pop = screen.getByRole('dialog', { name: 'Details' });
    expect(pop).toHaveClass('ui-popover');
    expect(pop.style.zIndex).toBe('');
    expect(pop.parentElement).toBe(document.body);
  });

  it('an outside press closes; a press inside or on the anchor does not', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.pointerDown(screen.getByText('Inside'));
    fireEvent.pointerDown(screen.getByText('Open'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByText('Elsewhere'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape closes and returns focus to the anchor', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    act(() => screen.getByText('Inside').focus());
    fireEvent.keyDown(screen.getByText('Inside'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByText('Open'));
  });

  it('moves again when the window changes size', () => {
    setViewport(1024, 768);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(240);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200);
    render(<Harness anchorRect={rect(700, 100, 36, 30)} />);
    const pop = screen.getByRole('dialog', { name: 'Details' });
    expect(parseFloat(pop.style.left)).toBe(700);
    setViewport(800, 768);
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(parseFloat(pop.style.left) + 240).toBeLessThanOrEqual(800 - 8);
  });
});
