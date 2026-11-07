/** Types for the Coach's review module (the tests import it). */
import type { AssistReq } from './prompts.mjs';

export type ReviewScope = { kind: 'thread' | 'project' | 'range'; ids?: string[]; from?: string; to?: string };
export type FindingKind = 'went-well' | 'handoff' | 'plan' | 'check' | 'reuse' | 'parallel';
export interface Finding { kind: FindingKind; quote: string; note: string }
export interface NextStep { text: string; action?: { kind: string; payload: Record<string, unknown> } }
export interface ReviewPlan { scope: ReviewScope; threads: string[]; chunks: number; estPercent: number; fits: boolean; smallerScope?: ReviewScope }
export const CHUNK_CHARS: number;
export const PERCENT_PER_CHUNK: number;
export const MAX_THREADS: number;
export const FINDING_KINDS: readonly FindingKind[];
export const REVIEW_SYSTEM: string;
export function chunkTranscript(items: unknown[], max?: number): string[];
export function planReview(scope: ReviewScope, threads: { id: string; chunks: number }[], budget: { usedPercent?: number | null; capPercent?: number | null } | null): ReviewPlan;
export function reviewPrompt(chunk: string, memory: unknown, goals?: { text: string }[]): AssistReq;
export function parseReview(text: unknown, chunk: string): { findings: Finding[]; nextSteps: NextStep[] } | null;
export function mergeReview(parts: { findings?: Finding[]; nextSteps?: NextStep[] }[], meta?: { read?: number }): { summary: string; findings: Finding[]; nextSteps: NextStep[] };
export function eventsFromTranscript(terminalId: string, sessionId: string | null, items: unknown[]): Record<string, unknown>[];
