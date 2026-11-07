/** Types for the Coach's memory module (the tests import it). */
export interface Fact { id: string; text: string; source: string; at: string; confirmedAt: string | null }
export interface Muted { type: string; until: string | null; reason: string; at: string; reviewedAt?: string }
export interface Memory {
  facts: Fact[];
  known: string[];
  levelAdjust: Record<string, number>;
  muted: Muted[];
  weights: Record<string, number>;
  bad: { type: string; situation: string | null; at: string }[];
  dates: Record<string, string>;
}
export type Reason = 'already' | 'not-relevant' | 'too-basic' | 'too-advanced' | 'wrong' | 'not-now' | 'up' | 'down' | 'fewer' | 'off';
export interface Feedback { cardType: string; measure?: string | null; reason: Reason | string; text?: string; headline?: string; situation?: string }
type When = Date | number | string;
export const REASONS: Readonly<Record<'already' | 'not-relevant' | 'too-basic' | 'too-advanced' | 'wrong' | 'not-now', string>>;
export const RECONFIRM_DAYS: number;
export const REVIEW_DAYS: number;
export function typeLabel(type: string): string;
export function emptyMemory(): Memory;
export function normalizeMemory(m: unknown): Memory;
export function applyFeedback(memory: Partial<Memory> | null, fb: Feedback, now?: When): { memory: Memory; effect: string; undo: Memory; rest: boolean; proposedFact?: Fact };
export function confirmFact(memory: Partial<Memory> | null, fact: Fact, now?: When): Memory;
export function editFact(memory: Partial<Memory> | null, id: string, text: string, now?: When): Memory;
export function removeItem(memory: Partial<Memory> | null, kind: 'fact' | 'known' | 'level' | 'muted' | string, key: string): Memory;
export function allows(memory: Partial<Memory> | null, c: { id: string; type: string }, now?: When): boolean;
export function factsToReconfirm(memory: Partial<Memory> | null, now?: When): Fact[];
export function dueForReview(memory: Partial<Memory> | null, now?: When): Muted[];
export function reviewMuted(memory: Partial<Memory> | null, type: string, showAgain: boolean, now?: When): Memory;
export function resetMemory(): Memory;
export function stripExcerpts<T extends { items?: unknown[] } | null | undefined>(doc: T): T;
export function memoryItems(memory: Partial<Memory> | null): { kind: 'fact' | 'known' | 'level' | 'muted'; key: string; label: string; source: string; at: string }[];
