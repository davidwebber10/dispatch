import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Marquee } from './Marquee';

/** jsdom has no layout: set the box and the text widths by hand. */
function widths(box: number, text: number) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return (this as HTMLElement).dataset.marquee === 'box' ? box : 0; } });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get() { return (this as HTMLElement).dataset.marquee === 'text' ? text : 0; } });
}
function reducedMotion(on: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({ matches: on && q.includes('reduce'), media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} })) as any;
}

/** The two fade widths, left and right: they animate, so the fades come and go smoothly. */
const edges = (box: HTMLElement) => [box.style.getPropertyValue('--mq-l'), box.style.getPropertyValue('--mq-r')];

describe('Marquee (2026-11-07)', () => {
  beforeEach(() => { vi.useFakeTimers(); reducedMotion(false); });
  afterEach(() => { vi.useRealTimers(); });

  it('a name that fits never moves', () => {
    widths(200, 150);
    const { container } = render(<Marquee text="Short name" />);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByText('Short name').style.transform).toBe('');
    expect((container.querySelector('[data-marquee="box"]') as HTMLElement).style.maskImage).toBe(''); // nothing cut, nothing faded
  });

  it('a long name fades at its cut edge (no ellipsis), waits 3 s, scrolls to its end slowly, pauses, and comes back', () => {
    widths(200, 290); // 90 px hidden
    const { container } = render(<Marquee text="POLYWOOD.com Performance work for the storefront" />);
    const box = container.querySelector('[data-marquee="box"]') as HTMLElement;
    const text = screen.getByText('POLYWOOD.com Performance work for the storefront');
    expect(text.style.textOverflow).not.toBe('ellipsis');
    expect(edges(box)).toEqual(['0px', '22px']); // the right edge fades out
    expect(box.style.transition).toContain('--mq-l'); // the fades fade in and out, not on and off
    expect(box.style.transition).toContain('--mq-r');
    act(() => { vi.advanceTimersByTime(2_900); });
    expect(text.style.transform).toBe('');
    act(() => { vi.advanceTimersByTime(200); });
    expect(text.style.transform).toBe('translateX(-90px)');
    expect(text.style.transition).toBe('transform 3000ms linear'); // 30 px a second
    expect(edges(box)).toEqual(['22px', '22px']); // moving: both edges fade
    act(() => { fireEvent.transitionEnd(text); });
    expect(edges(box)).toEqual(['22px', '0px']); // at the end: the left edge fades, the end shows whole
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(text.style.transform).toBe('translateX(0px)');
    act(() => { fireEvent.transitionEnd(text); });
    expect(edges(box)).toEqual(['0px', '22px']); // back at rest, then it waits and repeats
    act(() => { vi.advanceTimersByTime(3_100); });
    expect(text.style.transform).toBe('translateX(-90px)');
  });

  it('with Reduce Motion on, a long name keeps its fade and never moves', () => {
    reducedMotion(true);
    widths(200, 290);
    const { container } = render(<Marquee text="A very long thread name that does not fit" />);
    act(() => { vi.advanceTimersByTime(10_000); });
    const text = screen.getByText('A very long thread name that does not fit');
    expect(text.style.transform).toBe('');
    expect(edges(container.querySelector('[data-marquee="box"]') as HTMLElement)).toEqual(['0px', '22px']);
  });
});
