/** Types for the Coach's goals module (the tests import it). */
import type { Memory, Goal } from './memory.mjs';
import type { Measure, DetectorId } from './detectors.mjs';
import type { Budget } from './plan.mjs';
import type { CoachSettings } from './settings.mjs';

export interface GoalShape { text: string; measures: Measure[]; detectors: DetectorId[] }
type When = Date | number | string;
type Scores = Partial<Record<Measure, { score: number; trend?: number; enough: boolean }>> | null | undefined;
export const MAX_ACTIVE: number;
export const DETECTORS_OF: Readonly<Record<Measure, DetectorId[]>>;
export function activeGoals(memory: Partial<Memory> | null | undefined): Goal[];
export function addGoal(memory: Partial<Memory> | null | undefined, goal: { text: string; measures: string[]; detectors: string[]; source: 'user' | 'suggested' }, now?: When): { memory: Memory; ok: boolean; goal?: Goal };
export function setGoalStatus(memory: Partial<Memory> | null | undefined, id: string, status: 'active' | 'done', now?: When): Memory;
export function editGoal(memory: Partial<Memory> | null | undefined, id: string, text: string, mapped?: { measures: string[]; detectors: string[] } | null): Memory;
export function suggestGoals(state: unknown, measures: Scores, memory: Partial<Memory> | null | undefined, candidates?: { items?: { type: string }[] } | null): GoalShape[];
export function keywordMap(text: string): { measures: Measure[]; detectors: DetectorId[] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapGoal(text: string, deps: { assist: ((req: any) => Promise<any>) | null; settings: CoachSettings; budget: Budget | null }): Promise<{ measures: Measure[]; detectors: DetectorId[]; via: 'model' | 'keywords' }>;
export function goalFor<T extends { type: string; measure: string }>(c: T, goals: Goal[]): Goal | null;
export function rankCandidates<T extends { type: string; measure: string }>(candidates: T[], memory: Partial<Memory> | null | undefined): (T & { goal?: string })[];
export function goalProgress(goal: Goal, measures: Scores): { id: string; text: string; progress: string; next: string };
