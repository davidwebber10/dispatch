import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ViewModeMiniature } from './ViewModeMiniature';

// The picker's whole premise is that the two thumbnails are visually distinguishable at a
// glance — a test that merely renders both proves nothing (see the spec: "two thumbnails that
// are hard to tell apart are two modes that probably shouldn't both exist"). So assert on the
// actual band colors: Board carries the needs-help/complete/working accent colors, Threads
// carries none of them.
//
// jsdom's CSSOM normalizes hex colors to rgb() on read but leaves var(...) references literal
// (verified empirically), so the two constant styles below are intentionally different shapes.
const NEEDS_HELP = 'rgb(232, 176, 75)'; // #e8b04b
const COMPLETE = 'rgb(90, 141, 214)'; // #5A8DD6
const WORKING = 'var(--color-accent)';

describe('ViewModeMiniature', () => {
  it('renders a flat, uniformly-colored list of bars for threads', () => {
    render(<ViewModeMiniature mode="threads" />);
    const bars = screen.getAllByTestId('viewmode-bar');
    expect(bars.length).toBeGreaterThan(1);
    const colors = new Set(bars.map((b) => b.style.background));
    expect(colors.size).toBe(1); // uniform — a single muted grey, not banded
  });

  it('does not carry any board accent color for threads', () => {
    render(<ViewModeMiniature mode="threads" />);
    const bars = screen.getAllByTestId('viewmode-bar');
    for (const b of bars) {
      expect(b.style.background).not.toBe(NEEDS_HELP);
      expect(b.style.background).not.toBe(COMPLETE);
      expect(b.style.background).not.toBe(WORKING);
    }
  });

  it('renders amber, blue, and working-accent bands for board, in that order', () => {
    render(<ViewModeMiniature mode="board" />);
    const bars = screen.getAllByTestId('viewmode-bar');
    const colors = bars.map((b) => b.style.background);
    expect(colors).toContain(NEEDS_HELP);
    expect(colors).toContain(COMPLETE);
    expect(colors).toContain(WORKING);
    // grouped: needs-help bars precede complete bars precede the working bar, top to bottom.
    expect(colors.indexOf(NEEDS_HELP)).toBeLessThan(colors.indexOf(COMPLETE));
    expect(colors.indexOf(COMPLETE)).toBeLessThan(colors.indexOf(WORKING));
  });

  it('uses more than one color for board — it is banded, not uniform', () => {
    render(<ViewModeMiniature mode="board" />);
    const bars = screen.getAllByTestId('viewmode-bar');
    const colors = new Set(bars.map((b) => b.style.background));
    expect(colors.size).toBeGreaterThan(1);
  });
});
