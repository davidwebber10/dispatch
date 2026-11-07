/** Types for the Coach's cadence module (the tests import it). */
import type { CoachSettings } from './settings.mjs';

export interface Cadence {
  day: string | null;
  shownToday: number;
  shownThisSession: number;
  lastShownAt: string | null;
  mutedUntil: string | null;
  restUntilByType: Record<string, string>;
  dismissCount: Record<string, number>;
  firstSeenAt: string;
  welcomeDone: boolean;
}
type When = Date | number | string;
export const LEVEL_CAP: Readonly<{ off: number; quiet: number; normal: number; chatty: number }>;
export const REST_DAYS: number;
export const SESSION_GAP_MS: number;
export const FIRST_WEEK_MS: number;
export function dayKey(now: When): string;
export function emptyCadence(now: When): Cadence;
export function isMuted(state: Partial<Cadence> | null, now: When): boolean;
export function mutedForever(state: Partial<Cadence> | null): boolean;
export function inQuietHours(quiet: { from: string; to: string } | null | undefined, now: When): boolean;
export function mayShow(state: Partial<Cadence> | null, settings: CoachSettings, now: When, kind: 'card' | 'recap', opts?: { type?: string; phone?: boolean; welcome?: boolean }): boolean;
export function noteShown(state: Partial<Cadence>, now: When): Cadence;
export function dismiss(state: Partial<Cadence>, type: string, now: When): { state: Cadence; offerTurnOff: boolean };
export function mute(state: Partial<Cadence>, how: 'hour' | 'today' | 'on', now: When): Cadence;
export function unmute(state: Partial<Cadence>): Cadence;
