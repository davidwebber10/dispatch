/** Types for the Coach's measures module (the tests import it). */
import type { Measure } from './detectors.mjs';

export interface MeasureValue { score: number; trend: -1 | 0 | 1; enough: boolean }
export type Measures = Record<Measure, MeasureValue>;
export interface MeasuresDoc { history: { day: string; at: string; scores: Partial<Record<Measure, number>> }[]; [k: string]: unknown }
export const MEASURE_IDS: readonly Measure[];
export const MIN_PROMPTS: number;
export const MIN_THREADS: number;
export function measures(state: unknown, now: Date | number | string, before?: Partial<Record<Measure, number>> | null): Measures;
export function weakest(m: Partial<Record<Measure, { score: number; trend?: number; enough: boolean }>> | null | undefined, levelAdjust?: Record<string, number>): Measure | null;
export function snapshot(doc: MeasuresDoc | null | undefined, scores: Partial<Record<Measure, number>>, now: Date | number | string): MeasuresDoc;
export function scoresBefore(doc: MeasuresDoc | null | undefined, now: Date | number | string): Partial<Record<Measure, number>> | null;
export function scoresOnly(m: Measures): Record<Measure, number>;
