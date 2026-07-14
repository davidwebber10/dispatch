import { useEffect, useState } from 'react';

/** Default inactivity deadline: 12 hours. Mirrors core's DEFAULT_AUTO_ARCHIVE_MS. */
export const DEFAULT_AUTO_ARCHIVE_MS = 43_200_000;

export type DurationUnit = 'minutes' | 'hours' | 'days';

export const UNIT_MS: Record<DurationUnit, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

/**
 * Render ms as the largest unit that divides evenly, so a stored 43_200_000
 * reads back as "12 hours" rather than "720 minutes". The policy is stored in
 * ms precisely so the unit picker stays presentational.
 */
export function toDuration(ms: number): { value: number; unit: DurationUnit } {
  for (const unit of ['days', 'hours'] as const) {
    if (ms % UNIT_MS[unit] === 0) return { value: ms / UNIT_MS[unit], unit };
  }
  return { value: Math.max(1, Math.round(ms / UNIT_MS.minutes)), unit: 'minutes' };
}

export function fromDuration(value: number, unit: DurationUnit): number {
  return value * UNIT_MS[unit];
}

/** The thread's deadline in ms, or null if it never opted in. */
export function getAutoArchiveMs(config: Record<string, unknown>): number | null {
  if (!config || config.autoArchive !== true) return null;
  const ms = config.autoArchiveMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return DEFAULT_AUTO_ARCHIVE_MS;
  return ms;
}

/** Time left before the thread archives itself. Clamped at zero. */
export function remainingMs(lastActivityAt: string, autoArchiveMs: number, now: number = Date.now()): number {
  const last = Date.parse(lastActivityAt);
  if (!Number.isFinite(last)) return autoArchiveMs;
  return Math.max(0, last + autoArchiveMs - now);
}

/** Compact countdown for the sidebar badge: "3d", "11h", "45m", "<1m". */
export function formatRemaining(ms: number): string {
  if (ms >= UNIT_MS.days) return `${Math.floor(ms / UNIT_MS.days)}d`;
  if (ms >= UNIT_MS.hours) return `${Math.floor(ms / UNIT_MS.hours)}h`;
  if (ms >= UNIT_MS.minutes) return `${Math.floor(ms / UNIT_MS.minutes)}m`;
  return '<1m';
}

// Module-level shared ticker backing useMinuteTick: ONE setInterval for the whole
// module (not one per row), created lazily on the first active subscriber and torn
// down when the last one unmounts. Every subscriber's callback fires off the same
// tick, so N badges stay in lockstep instead of drifting on N separate timers.
let sharedTickId: ReturnType<typeof setInterval> | null = null;
const tickSubscribers = new Set<() => void>();

function subscribeMinuteTick(onTick: () => void): () => void {
  tickSubscribers.add(onTick);
  if (sharedTickId === null) {
    sharedTickId = setInterval(() => {
      for (const fn of tickSubscribers) fn();
    }, 60_000);
  }
  return () => {
    tickSubscribers.delete(onTick);
    if (tickSubscribers.size === 0 && sharedTickId !== null) {
      clearInterval(sharedTickId);
      sharedTickId = null;
    }
  };
}

/**
 * One shared 60-second tick for every countdown badge, so N rows don't each hold
 * their own timer. Pass `active=false` for rows with no badge to update (no
 * auto-archive policy) — an inactive caller does not subscribe to the ticker and
 * never re-renders from it. Returns the current epoch ms.
 */
export function useMinuteTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now()); // catch up on whatever elapsed before this row went active
    return subscribeMinuteTick(() => setNow(Date.now()));
  }, [active]);
  return now;
}
