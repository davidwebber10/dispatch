/** Types for the Coach plugin's web part (the tests import it). */
import type { CoachSettings } from './lib/settings.mjs';

export interface CoachStore {
  getState(): { loaded: boolean; settings: CoachSettings; [k: string]: unknown };
  setState(partial: Record<string, unknown>): void;
}
export interface CoachDeps {
  /** The detail behind "More": called once per card, on click. */
  requestMore?: (card: unknown) => Promise<unknown>;
  /** The clock (tests). */
  now?: () => Date;
}
export function createCoach(d: unknown, deps?: CoachDeps): { store: CoachStore; ready: Promise<void>; [k: string]: unknown };
export default function activate(d: unknown): void;
