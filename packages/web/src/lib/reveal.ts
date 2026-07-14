/**
 * Reveal the active row/chip inside a scroll container.
 *
 * `block`/`inline: 'nearest'` is doing all the work here. The browser scrolls the MINIMUM distance
 * needed to bring the element into view, and does *nothing at all* when it is already fully
 * visible. That is what lets us fire this on every activation without ever fighting a user who is
 * already looking straight at the thing they clicked — the "did it move out of view?" check is the
 * browser's, not ours.
 *
 * Resolution is by `data-*` attribute + `querySelector` from a ref on the scroll container, rather
 * than a ref per row. That follows the existing pattern in ConversationView, and it matters here:
 * the tab chips already compose two dnd-kit refs (draggable + droppable), so adding a third would
 * mean threading yet another callback ref through them.
 */

/** Returns whether a match was found, so a caller can fall back to a coarser target. */
export function revealIn(container: HTMLElement | null | undefined, selector: string): boolean {
  const el = container?.querySelector<HTMLElement>(selector);
  if (!el) return false;
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}

/**
 * Matches the chip for `tabId` — either a chip that IS that tab, or a merged GROUP chip that
 * contains it. A group's panes have no chip of their own; the group chip is their only presence in
 * the strip, so activating a pane inside one has to reveal the group. `~=` matches one
 * whitespace-separated token, so it cannot match on a partial id.
 */
export function tabChipSelector(tabId: string): string {
  return `[data-tab-id="${tabId}"], [data-tab-ids~="${tabId}"]`;
}
