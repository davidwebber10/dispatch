import { create } from 'zustand';

let nonce = 0;

/** A request to scroll View mode to a specific transcript line (from search). */
interface ViewJumpState {
  target: { terminalId: string; line: number; nonce: number } | null;
  jumpTo: (terminalId: string, line: number) => void;
  clear: () => void;
}

export const useViewJump = create<ViewJumpState>((set) => ({
  target: null,
  jumpTo: (terminalId, line) => set({ target: { terminalId, line, nonce: ++nonce } }),
  clear: () => set({ target: null }),
}));
