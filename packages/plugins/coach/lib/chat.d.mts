/** Types for the Coach's chat module (the tests import it). */
import type { AssistReq } from './prompts.mjs';

export type ChatActionKind = 'add-goal' | 'create-skill' | 'schedule' | 'build-plugin' | 'new-threads';
export interface ChatAction { kind: ChatActionKind; payload: Record<string, unknown> }
export interface ChatTurn { role: 'user' | 'coach'; text: string; at: string; terminalId?: string; actions?: ChatAction[] }
export interface ChatContext { observations: string[]; enoughData: boolean; activeDays: number; needs: string; scope: 'thread' | 'me' }
export const CHAT_KEEP: number;
export const CHAT_SYSTEM: string;
export function threadObservations(state: unknown, terminalId: string | null | undefined): string[];
export function chatContext(state: unknown, measures: unknown, memory: unknown, cards: unknown[] | null | undefined, opts?: { now?: Date; terminalId?: string | null }): ChatContext;
export function chatPrompt(ctx: ChatContext, history: { role: string; text: string; at?: string }[], question: string): AssistReq;
export function parseChat(raw: unknown): { text: string; actions: ChatAction[] } | null;
export function appendTurns<T extends { turns?: unknown[] }>(doc: T | null | undefined, turns: unknown[]): T & { turns: unknown[] };
