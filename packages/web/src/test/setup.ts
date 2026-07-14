import '@testing-library/jest-dom/vitest';

// jsdom has no layout engine, so it ships no Element.prototype.scrollIntoView at all — calling it
// throws "scrollIntoView does not exist", and so does vi.spyOn'ing it. Components that reveal the
// active row (the tab strip, the project sidebar) call it for real, so give jsdom a no-op. Tests
// spy on this to assert WHICH element was revealed and with which options.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() { /* no layout in jsdom */ };
}
