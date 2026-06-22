import { create } from 'zustand';
import type { ServerEvent } from '../api/events-socket';

export interface PromptOption { label: string; keys: string }
export interface DetectedPrompt {
  kind: string;
  question: string;
  options: PromptOption[];
  parsed: boolean;
  raw?: string;
}

interface PromptsState {
  byTerminal: Record<string, DetectedPrompt | null>;
  applyEvent: (e: ServerEvent) => void;
}

/** Live interactive prompt per terminal, from `terminal:prompt` events. */
export const usePrompts = create<PromptsState>((set, get) => ({
  byTerminal: {},
  applyEvent: (e) => {
    if (e.type === 'terminal:prompt' && typeof e.terminalId === 'string') {
      set({ byTerminal: { ...get().byTerminal, [e.terminalId]: (e.prompt as DetectedPrompt | null) ?? null } });
    }
  },
}));
