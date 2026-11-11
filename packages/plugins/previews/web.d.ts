/** Types for the Previews plugin's exported helpers (the tests import them). */
export type DropKind = 'command' | 'link' | 'code' | 'secret' | 'steps' | 'diff' | 'table' | 'doc' | 'text' | 'images' | 'files';
export interface PreviewDoc { id: string; sessionId: string; sessionName?: string | null; terminalId?: string | null; terminalLabel?: string | null; title: string; note?: string | null; text?: string | null; files: { fileId: string; name: string; mime: string; size: number }[]; createdAt: string; seenAt: string | null;
  /** Drops (2026-11-11): the kind and its fields; absent on older drops (the look is inferred). */
  kind?: string; commands?: string[]; cwd?: string; url?: string; language?: string; steps?: { text: string; command?: string }[]; expired?: boolean }
/** The name the user reads ("Drops"). */
export const NAME: string;
export function inferKind(p: Partial<PreviewDoc>): DropKind;
export function maskSecret(v: string): string;
export function expireSecret<T extends Partial<PreviewDoc>>(doc: T, now?: number): T | null;
export function parseCsv(text: string): string[][];
export function filterPreviews<T extends PreviewDoc>(items: T[], f: { project?: string | null; thread?: string | null; query?: string }, nameOf?: (id: string) => string | undefined): T[];
export function projectsWithPreviews(items: PreviewDoc[], nameOf?: (id: string) => string | undefined): { id: string; name: string; count: number }[];
export function threadsWithPreviews(items: PreviewDoc[], project: string | null): { id: string; label: string; count: number }[];
export function looksLikeMarkdown(text: string, title?: string): boolean;
export default function activate(d: unknown): void;
