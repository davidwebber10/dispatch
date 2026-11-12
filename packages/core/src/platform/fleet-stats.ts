// packages/core/src/platform/fleet-stats.ts
// The optional heartbeat keys for OS fleet management (Admin → Environments; OS contract, section
// "Fleet management"): `usageLimits` (the usage gauge, compact) and `disk` (the home's use, and the
// state volume's when it is another file system). Each reading is best effort: an error leaves the key
// out, which OS shows as "unknown".
import fs from 'node:fs';
import type { UsageSummary } from '../limits/gauge.js';

export interface DiskUse { usedBytes: number; totalBytes: number }
/** `usedBytes`/`totalBytes`: the home (what OS reads). `state`: the daemon's state volume, when it is another file system. */
export interface HeartbeatDisk extends DiskUse { state?: DiskUse }
/** The highest use of any account, in percent (0 to 100); null when no account reported the window. */
export interface HeartbeatLimits { weekPercent: number | null; sessionPercent: number | null }

/** The weekly window (all models) and the five-hour session window, by the gauge's window keys. */
const WEEK = 'seven_day';
const SESSION = 'five_hour';

const pct = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);

/** The gauge summary, compact: the worst account's weekly and session use. Undefined when there is no summary. */
export function compactLimits(summary: UsageSummary | null | undefined): HeartbeatLimits | undefined {
  if (!summary || !Array.isArray(summary.providers)) return undefined;
  let week: number | null = null;
  let session: number | null = null;
  for (const p of summary.providers) {
    const w = pct(p.windows?.[WEEK]?.usedPercent);
    const s = pct(p.windows?.[SESSION]?.usedPercent);
    if (w !== null) week = week === null ? w : Math.max(week, w);
    if (s !== null) session = session === null ? s : Math.max(session, s);
  }
  return { weekPercent: week, sessionPercent: session };
}

type StatFs = (p: string) => { bsize: number; blocks: number; bfree: number; type?: number };

function use(dir: string, statfs: StatFs): DiskUse | null {
  try {
    const s = statfs(dir);
    const total = Number(s.blocks) * Number(s.bsize);
    const used = (Number(s.blocks) - Number(s.bfree)) * Number(s.bsize);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(used) || used < 0) return null;
    return { usedBytes: used, totalBytes: total };
  } catch {
    return null;
  }
}

/** The file system of a folder, so two folders on one volume are counted once. */
function deviceOf(dir: string): number | null {
  try { return fs.statSync(dir).dev; } catch { return null; }
}

/**
 * The home's use, and the state volume's when it is a different file system. Undefined when the home
 * cannot be read (statfs is missing on an old Node, or the folder is gone).
 */
export function diskUse(home: string, stateDir: string | null, statfs: StatFs = (p) => fs.statfsSync(p) as never): HeartbeatDisk | undefined {
  const h = use(home, statfs);
  if (!h) return undefined;
  const out: HeartbeatDisk = { ...h };
  if (stateDir) {
    const hd = deviceOf(home);
    const sd = deviceOf(stateDir);
    if (sd !== null && sd !== hd) {
      const s = use(stateDir, statfs);
      if (s) out.state = s;
    }
  }
  return out;
}

/** One optional heartbeat reading: undefined when it throws, so a beat is never lost to it. */
export function bestEffort<T>(read: () => T | undefined): T | undefined {
  try { return read(); } catch { return undefined; }
}
