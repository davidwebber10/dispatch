/** Types for the Coach's settings module (the tests import it). */
export interface Thresholds {
  repeatedPrompt: { count: number; days: number };
  serialIndependent: { threads: number; maxMinutes: number; windowHours: number };
  idleWait: { minutes: number };
  stepByStep: { prompts: number; minutes: number; maxChars: number };
  noPlanBigTask: { minChars: number; minParts: number };
  fastApprove: { seconds: number; longTurnMinutes: number };
  narrowBreadth: { share: number; days: number; minThreads: number };
  pluginFit: { minRepeats: number; days: number; minSteps: number };
}
export type TierModel = { harness: string; model: string };
export interface CoachSettings {
  howOften: 'off' | 'quiet' | 'normal' | 'chatty';
  maxPerDay: number;
  maxPerSession: number;
  quietHours: { from: string; to: string } | null;
  phone: boolean;
  tipTypes: { prompt: boolean; thinkBigger: boolean };
  leaveAlone: string[];
  thoroughness: 'economy' | 'balanced' | 'thorough' | 'budget';
  model: { mode: 'auto' } | { mode?: 'pick'; small: TierModel; large: TierModel };
  budgetPercentWeekly: number;
  budgetUsdWeekly: number;
  recap: { inApp: boolean; push: boolean };
  advanced: { thresholds: Thresholds; minConfidence: number };
}
export const DEFAULT_THRESHOLDS: Thresholds;
export const DEFAULT_SETTINGS: CoachSettings;
/** A partial, deep: what a saved settings document may hold. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export function withDefaults(saved: DeepPartial<CoachSettings> | Record<string, unknown> | null | undefined): CoachSettings;
