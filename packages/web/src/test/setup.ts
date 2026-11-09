import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';
import { forgetDraftMemory } from '../hooks/useDraft';
import { threadViewCache } from '../lib/threadViewCache';

// Drafts live in the page's memory first (hooks/useDraft.ts); each test starts like a fresh page,
// so a test that clears local storage starts with no drafts.
beforeEach(() => forgetDraftMemory());

// The chat view cache (lib/threadViewCache.ts) is page memory too: without this, the items of thread
// 't1' in one test would be the first render of 't1' in the next (W2-I).
beforeEach(() => threadViewCache.clear());

// jsdom has no layout engine, so it ships no Element.prototype.scrollIntoView at all — calling it
// throws "scrollIntoView does not exist", and so does vi.spyOn'ing it. Components that reveal the
// active row (the tab strip, the project sidebar) call it for real, so give jsdom a no-op. Tests
// spy on this to assert WHICH element was revealed and with which options.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() { /* no layout in jsdom */ };
}
