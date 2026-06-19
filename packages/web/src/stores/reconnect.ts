import { create } from 'zustand';

// A monotonically-increasing generation. Terminal hosts include it in their
// React key, so bumping it remounts every live terminal with a fresh socket —
// the programmatic equivalent of the user's "back out then back in" workaround
// after iOS suspends the WebSocket in the background.
interface Reconnect {
  gen: number;
  bump: () => void;
}

export const useReconnect = create<Reconnect>((set) => ({
  gen: 0,
  bump: () => set((s) => ({ gen: s.gen + 1 })),
}));
