/** Types for the Coach's weekly recap module (the tests import it). */
import type { Measures } from './measures.mjs';
import type { Measure } from './detectors.mjs';
import type { CardAction } from './prompts.mjs';

export interface Recap {
  week: string;
  stats: { threads: number; days: number; parallel: number };
  patterns: string[];
  stretch: { measure: Measure; headline: string; why: string; action: CardAction; check?: string } | null;
  learned: string | null;
  goals?: { id: string; text: string; progress: string; next: string }[];
  askGoals?: boolean;
}
export const MIN_ACTIVE_DAYS: number;
export function activeDays(state: unknown, now: Date | number | string, days?: number): number;
export function buildRecap(state: unknown, ctx: { memory: unknown; measures: Measures | null | undefined; cards?: unknown[]; now: Date | number | string }): Recap | null;
