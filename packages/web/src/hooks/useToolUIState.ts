import { useState, type Dispatch, type SetStateAction } from 'react';

/**
 * A useState() drop-in whose value survives a component remount, keyed by a stable item id
 * (a ConvItem's uuid/toolId). ChatView's renderTimeline re-anchors a still-streaming assistant
 * turn's enclosing MessageScroller.Item `key` to whichever item is now LAST in the group on
 * every appended block (see its doc comment) — a changed `key` makes React treat the turn's
 * whole subtree as unmounted, discarding any plain `useState` inside it (an expanded tool
 * call, a selected Input/Output tab, ...). Backed by a plain module-level Map rather than
 * React state, so writing to it doesn't itself trigger a re-render anywhere else — a fresh
 * component instance just reads it back as its initial value instead of defaulting.
 */
function createPersistedState<T>() {
  const store = new Map<string, T>();
  function usePersistedState(id: string | undefined, initial: T): [T, Dispatch<SetStateAction<T>>] {
    const [value, setValue] = useState<T>(() => (id !== undefined && store.has(id) ? store.get(id)! : initial));
    const setPersisted: Dispatch<SetStateAction<T>> = (next) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        if (id !== undefined) store.set(id, resolved);
        return resolved;
      });
    };
    return [value, setPersisted];
  }
  /**
   * The stored value for `id`, read once and without a subscription (`undefined` when nothing
   * was stored). For a parent that needs a child's state at its own next render (ToolGroup
   * asks if the reader opened one of its calls); a write here re-renders only the writer.
   */
  usePersistedState.peek = (id: string | undefined): T | undefined => (id !== undefined ? store.get(id) : undefined);
  return usePersistedState;
}

/** Whether a tool call/result's expanded shelf is open, keyed by tool id. */
export const useToolExpanded = createPersistedState<boolean>();
/** Whether a thought (thinking block) is open, keyed by the block's stable key (2026-11-06). */
export const useThoughtExpanded = createPersistedState<boolean>();

/**
 * The key per-block UI state lives under: the tool id when there is one, else the key the block
 * was first streamed under (kept across the uuid upgrade), else the item's uuid. Every block of a
 * settled message shares one `uuid`, so `uuid` alone would make all the thoughts of a message open
 * and close together, and the upgrade from the synthetic `s-` key to that uuid would reset them.
 */
export function uiKeyOf(it: { toolId?: string; blockKey?: string; uuid?: string }): string | undefined {
  return it.toolId ?? it.blockKey ?? it.uuid;
}
/** Which tab (Input/Output) a tool call's generic shelf has selected, keyed by tool id. */
export const useToolTab = createPersistedState<'input' | 'output'>();
/**
 * Tri-state expansion for a ToolGroup (a run of consecutive same-tool calls), keyed by
 * group id. `undefined` = auto (expanded while any member is running, collapsed once the
 * run settles) — the untouched default. `true`/`false` = the reader has explicitly
 * toggled the group, and that choice wins permanently thereafter, even across the
 * running→settled transition. A plain boolean (as `useToolExpanded` stores) can't
 * represent "untouched," which is why this is a separate persisted map rather than
 * reusing that one.
 */
export const useToolGroupExpanded = createPersistedState<boolean | undefined>();
/**
 * Whether a folded activity strip (timeline/activityFold.tsx) is open, keyed by the strip's FIRST
 * item. `undefined` = untouched: closed, unless the reader opened a call inside it. A separate map,
 * so the strip's own choice never changes a ToolGroup inside it.
 */
export const useActivityFoldOpen = createPersistedState<boolean | undefined>();
