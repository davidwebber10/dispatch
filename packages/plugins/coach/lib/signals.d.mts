/** Types for the Coach's signals module (the tests import it). */
export interface PromptRec { t: string; p: string | null; at: string; ex: string; h: string; len: number; lines: number; parts: number; plan: boolean; ok: boolean; gap: number | null; prev: number | null }
export interface TurnRec { t: string; p: string | null; start: string; end: string; ms: number; outcome: string | null }
export interface ThreadRec { p: string | null; first: string; end: string | null; kind: string; prompts: number; tools: number; /** The hash of the first prompt, when a schedule or an agent (not the person) started the thread. */ auto?: string }
/** An instruction block (a paragraph of a longer prompt) and the threads it appeared in. */
export interface BlockRec { text: string; len: number; parts: number; p: string | null; last: string; seen: { t: string; at: string }[] }
export interface SignalsState {
  v: 1;
  /** normalized-hash → block (spec section 4.8: skill-fit). */
  blocks?: Record<string, BlockRec>;
  prompts: PromptRec[];
  turns: TurnRec[];
  threads: Record<string, ThreadRec>;
  /** terminalId → when it became busy. */
  open: Record<string, string>;
  /** terminalId → its last turn end. */
  last: Record<string, { end: string; ms: number }>;
}
export const EXCERPT_CHARS: number;
export function emptyState(): SignalsState;
export function normalize(text: string): string;
export function hashText(text: string): string;
export function classify(text: string): string;
export function countParts(text: string): number;
export function collect(event: Record<string, unknown>, state: SignalsState, settings?: { leaveAlone?: string[] } | null): SignalsState;
export function prune(state: SignalsState, nowIso: string): SignalsState;
