/** Types for the Coach's plan module (the tests import it). */
import type { CoachSettings } from './settings.mjs';

export type Step = 'confirm' | 'write' | 'more' | 'review-thread' | 'review-prompt' | 'recap';
export type Tier = 'small' | 'large' | 'none';
export type Level = 'small-only' | 'economy' | 'balanced' | 'thorough' | 'none';
export interface Budget { usedPercent?: number | null; capPercent?: number | null; usedUsd?: number | null; capUsd?: number | null }
export const LARGE_DEFAULT: Readonly<{ claude: string; codex: string; openrouter: string }>;
export const STEP_DOWN_AT: readonly number[];
export function budgetFraction(budget: Budget | null | undefined): number | null;
export function effectiveLevel(settings: CoachSettings | null | undefined, budget: Budget | null | undefined): { level: Level; stepped: boolean };
export function planCall(step: Step, settings: CoachSettings, budget: Budget | null | undefined, ctx?: { harness?: string | null }): { tier: Tier; level: Level; stepped: boolean; harness: string | undefined; model: string | undefined };
