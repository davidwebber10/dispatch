import { create } from 'zustand';

/** Transient app-wide hint (toast). One message at a time; auto-dismisses.
 *  For brief, non-blocking feedback where no inline slot exists (e.g. push
 *  enrollment failures from the bell toggles) — never for errors that need
 *  a decision. */
export const useHint = create<{ msg: string | null; show: (msg: string) => void }>((set) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    msg: null,
    show: (msg) => {
      clearTimeout(timer);
      timer = setTimeout(() => set({ msg: null }), 4000);
      set({ msg });
    },
  };
});
