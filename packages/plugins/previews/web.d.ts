/** Types for the Previews plugin's exported helpers (the tests import them). */
export interface PreviewDoc { id: string; sessionId: string; sessionName?: string | null; terminalId?: string | null; terminalLabel?: string | null; title: string; note?: string | null; text?: string | null; files: { fileId: string; name: string; mime: string; size: number }[]; createdAt: string; seenAt: string | null }
export function filterPreviews<T extends PreviewDoc>(items: T[], f: { project?: string | null; thread?: string | null; query?: string }, nameOf?: (id: string) => string | undefined): T[];
export function projectsWithPreviews(items: PreviewDoc[], nameOf?: (id: string) => string | undefined): { id: string; name: string; count: number }[];
export function threadsWithPreviews(items: PreviewDoc[], project: string | null): { id: string; label: string; count: number }[];
export function looksLikeMarkdown(text: string, title?: string): boolean;
export default function activate(d: unknown): void;
