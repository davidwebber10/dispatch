import { create } from 'zustand';

export const useSetup = create<{ forceOpen: boolean; open: () => void; close: () => void }>((set) => ({
  forceOpen: false,
  open: () => set({ forceOpen: true }),
  close: () => set({ forceOpen: false }),
}));
