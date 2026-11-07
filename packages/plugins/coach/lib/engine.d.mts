/** Types for the Coach worker's engine (the tests import it). */
export interface EngineIo {
  getDoc(key: string, fallback: unknown): Promise<unknown>;
  putDoc(key: string, value: unknown): Promise<unknown>;
  getSettings(): Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assist(req: any): Promise<any>;
  notify?(body: { title: string; body: string; url?: string }): Promise<unknown>;
  getJson?(route: string): Promise<unknown>;
  now(): Date;
  log?(...a: unknown[]): void;
  saveDelayMs?: number;
  readBudget?(harness: string | null): Promise<unknown>;
}
export const JUDGE_PER_RUN: number;
export const FRESH_MS: number;
export const BUDGET_TTL_MS: number;
export function createEngine(io: EngineIo): { load(): Promise<void>; handle(e: Record<string, unknown>): Promise<unknown>; flush(): Promise<void>; refreshBudget(): Promise<unknown>; idle(): Promise<unknown>; readonly state: unknown };
