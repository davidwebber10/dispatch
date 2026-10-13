/**
 * The compaction model behind one interface, so the compactor runs against a fake in tests
 * and the engine can move to OpenRouter (summarizer-choice.ts) without touching the queues.
 */
export interface SummarizerSession {
  /** Send one user message in this conversation; resolve with the reply text. */
  ask(text: string): Promise<string>;
  close(): void;
}
export interface SummarizerOpenOptions {
  systemPrompt: string;
  /** Called once, when the first response begins to stream (the cache-write gate). */
  onFirstToken: () => void;
}
export interface Summarizer { open(opts: SummarizerOpenOptions): SummarizerSession }

export interface Usage { input: number; cacheRead: number; cacheWrite: number; output: number }

export function usageOf(raw: unknown): Usage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  return { input: n(u.input_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens), output: n(u.output_tokens) };
}
