import { create } from 'zustand';

type Status = 'connecting' | 'open' | 'closed';

export const useConnection = create<{ status: Status; setStatus: (s: Status) => void }>((set) => ({
  status: 'connecting',
  setStatus: (status) => set({ status }),
}));
