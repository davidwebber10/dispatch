import { create } from 'zustand';

interface QuestionAnswersState {
  byUuid: Record<string, number[][]>;
  submit: (uuid: string, selections: number[][]) => void;
}

/** Optimistic record of which AskUserQuestion options the user clicked, keyed by
 *  the tool call's uuid — so the card reflects the choice immediately, before the
 *  thread's tool-result is polled in. */
export const useQuestionAnswers = create<QuestionAnswersState>((set) => ({
  byUuid: {},
  submit: (uuid, selections) => set((s) => ({ byUuid: { ...s.byUuid, [uuid]: selections } })),
}));
