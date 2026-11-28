import type { ConvItem } from '../../../../api/types';
import { uiKeyOf } from '../../../../hooks/useToolUIState';

// Stable fallback id for a ConvItem that has neither `uuid` nor `toolId` (e.g. a plain
// 'user'/'assistant'/'result' item built by useStructuredChat's non-streaming reconcile
// path). Keyed by OBJECT IDENTITY, not array index: an item's index shifts every time
// loadOlder() prepends an older page in FRONT of it, and an index-derived key would force
// React to unmount+remount that node on every page — breaking MessageScroller's
// preserveScrollOnPrepend, which tracks the reader's scroll anchor by DOM node identity.
// Item objects themselves are never mutated in place after creation (the streaming reveal
// path only rewrites items that already carry a real uuid), so a WeakMap-cached id stays
// attached to the same logical item for its whole life in `items`.
let fallbackIdCounter = 0;
const fallbackIds = new WeakMap<ConvItem, string>();
export function stableId(it: ConvItem): string {
  if (it.uuid) return it.uuid;
  if (it.toolId) return it.toolId;
  let id = fallbackIds.get(it);
  if (!id) { id = `fallback-${++fallbackIdCounter}`; fallbackIds.set(it, id); }
  return id;
}

/**
 * The React key of a drawn item. It differs from `stableId` in two ways that both keep a row
 * mounted (owner 2026-11-27: an open tool call lost its scroll position on each new line):
 * - a streamed block keeps its key when it gets its message's `uuid` (the tool id or the block's
 *   first key comes first), so the row is not built again when the message settles;
 * - the blocks of one settled message share that `uuid`, but each has its own key here, so two
 *   tool calls of one message never get the same React key.
 */
export function rowKey(it: ConvItem): string {
  return uiKeyOf(it) ?? stableId(it);
}
