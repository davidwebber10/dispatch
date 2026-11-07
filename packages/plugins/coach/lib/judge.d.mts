/** Types for the Coach's judge module (the tests import it). */
import type { Budget } from './plan.mjs';
import type { CoachSettings } from './settings.mjs';

export interface AssistAnswer { result: { text: string; harness?: string; [k: string]: unknown } | null; budget: Budget | null; refused: Record<string, unknown> | null }
export type AssistFn = (req: Record<string, unknown>) => Promise<AssistAnswer>;
export interface Call { step: string; tier: string; ok: boolean }
export interface Card { id: string; type: string; measure: string; headline: string; why: string; action: unknown; excerpt: string; reason: string; terminalId: string | null; projectId: string | null; at: string; [k: string]: unknown }
export interface Judged { id: string; card: Card | null; outcome: 'card' | 'dropped' | 'budget' | 'muted'; reason?: string; calls: Call[]; budget?: Budget | null; harness?: string | null }
export function budgetFromHeaders(headers: { get(k: string): string | null } | null | undefined): Budget | null;
export function reasonFor(c: { type: string; evidence?: Record<string, unknown> }): string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function judgeCandidate(c: unknown, deps: { settings: CoachSettings; memory: unknown; budget: Budget | null; assist: (req: any) => Promise<any>; now?: Date; harness?: string | null }): Promise<Judged>;
export function joinCards(doc: unknown, results: { id?: string; outcome: string; card: unknown; calls: unknown[] }[], at: string): { items: Card[]; judged: { id: string; at: string; outcome: string; calls: number }[] };
export function unjudged<T extends { id: string }>(candidates: T[], cardsDoc: unknown): T[];
