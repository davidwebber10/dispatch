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
  return function usePersistedState(id: string | undefined, initial: T): [T, Dispatch<SetStateAction<T>>] {
    const [value, setValue] = useState<T>(() => (id !== undefined && store.has(id) ? store.get(id)! : initial));
    const setPersisted: Dispatch<SetStateAction<T>> = (next) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        if (id !== undefined) store.set(id, resolved);
        return resolved;
      });
    };
    return [value, setPersisted];
  };
}

/** Whether a tool call/result's expanded shelf is open, keyed by tool id. */
export const useToolExpanded = createPersistedState<boolean>();
/** Which tab (Input/Output) a tool call's generic shelf has selected, keyed by tool id. */
export const useToolTab = createPersistedState<'input' | 'output'>();
