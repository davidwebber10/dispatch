/** Types for the Coach's prompts module (the tests import it). */
export interface AssistReq { system: string; messages: { role: 'user'; content: string }[]; maxTokens: number }
export interface CardAction { kind: 'compose' | 'schedule' | 'threads'; label: string; text?: string; prompt?: string; cron?: string; prompts?: string[] }
export const CONFIRM_SYSTEM: string;
export const WRITE_SYSTEM: string;
export const MORE_SYSTEM: string;
export const RECAP_SYSTEM: string;
export function memoryContext(memory: unknown): string;
export function confirmPrompt(candidate: unknown, memory: unknown): AssistReq;
export function writePrompt(candidate: unknown, memory: unknown, draft: unknown): AssistReq;
export function morePrompt(card: unknown, memory: unknown): AssistReq;
export function recapPrompt(draft: unknown, memory: unknown): AssistReq;
export function parseAnswer(text: unknown): Record<string, unknown> | null;
export function cleanAction(a: unknown): CardAction | null;
export function checkCard(ans: unknown, minConfidence: number): null | 'malformed' | 'no-fit' | 'unsure' | 'copy';
