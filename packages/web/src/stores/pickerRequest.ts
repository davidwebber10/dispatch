import { create } from 'zustand';

/**
 * "Open the model picker for this owner." The "/" menu (`/model`, `/effort`, the phone's Commands
 * sheet) and the picker button in the status row live in different components; this is the one
 * message between them. `owner` names a picker: `thread:<id>` or `chat`.
 */
interface PickerRequest {
  owner: string | null;
  request: (owner: string) => void;
  clear: () => void;
}

export const usePickerRequest = create<PickerRequest>((set) => ({
  owner: null,
  request: (owner) => set({ owner }),
  clear: () => set({ owner: null }),
}));
