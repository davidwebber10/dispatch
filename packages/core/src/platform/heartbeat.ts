import type Database from 'better-sqlite3';

/**
 * Publishes a small per-box state projection to OS.
 *
 * The box keeps SQLite as its system of record (design §4.4.5) — durability is
 * already handled, because $HOME is EFS. What OS cannot do is *read* that state
 * while the box is asleep or slow, and it needs to: the notifications bell, the
 * fleet view and the rate-limit view all want "how many of this user's threads
 * need input?" without a round trip into the box.
 *
 * So this is a projection, explicitly a CACHE and not a source of truth: it may be
 * one interval stale, which is fine for a bell badge and wrong for anything
 * transactional.
 *
 * Note it is deliberately NOT load-bearing for lifecycle decisions. Boxes are
 * always-on (design §8), so nothing here can stop a box mid-run — an earlier design
 * had the heartbeat driving idle-stop, which made a wrong reading destroy work.
 */

export interface BoxHeartbeat {
  ownerEmail: string | null;
  boxId: string | null;
  at: string;
  authenticated: boolean;
  threads: {
    total: number;
    working: number;
    needsInput: number;
    error: number;
  };
  /** Most recent activity across all threads, for the fleet view's "last active". */
  lastActivityAt: string | null;
  /** Whether OS-brokered tools resolved on the last attempt (design §4.2.1). */
  toolsReachable: boolean;
}

export interface HeartbeatOptions {
  baseUrl?: string;
  boxToken?: string;
  ownerEmail?: string;
  boxId?: string;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Collect the projection from the terminals table. Cheap: one small scan. */
export function collectHeartbeat(
  db: Database.Database,
  extra: { authenticated: boolean; toolsReachable: boolean; ownerEmail?: string; boxId?: string },
): BoxHeartbeat {
  let rows: Array<{ status: string; last_activity_at: string | null }> = [];
  try {
    rows = db
      .prepare(`SELECT status, last_activity_at FROM terminals WHERE archived_at IS NULL`)
      .all() as any;
  } catch {
    // A projection must never take the daemon down; an empty reading is honest enough.
    rows = [];
  }
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const lastActivityAt = rows
    .map((r) => r.last_activity_at)
    .filter((v): v is string => Boolean(v))
    .sort()
    .pop() ?? null;

  return {
    ownerEmail: extra.ownerEmail ?? null,
    boxId: extra.boxId ?? null,
    at: new Date().toISOString(),
    authenticated: extra.authenticated,
    threads: {
      total: rows.length,
      working: count('working'),
      needsInput: count('needs_input'),
      error: count('error'),
    },
    lastActivityAt,
    toolsReachable: extra.toolsReachable,
  };
}

export class HeartbeatService {
  private timer: NodeJS.Timeout | null = null;
  private readonly baseUrl?: string;
  private readonly boxToken?: string;
  private readonly ownerEmail?: string;
  private readonly boxId?: string;
  private readonly intervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly db: Database.Database,
    private readonly probe: () => { authenticated: boolean; toolsReachable: boolean },
    opts: HeartbeatOptions = {},
  ) {
    this.baseUrl = (opts.baseUrl ?? process.env.OS_BASE_URL)?.replace(/\/+$/, '') || undefined;
    this.boxToken = opts.boxToken ?? process.env.OS_BOX_TOKEN;
    this.ownerEmail = opts.ownerEmail ?? process.env.DISPATCH_OWNER_EMAIL;
    this.boxId = opts.boxId ?? process.env.DISPATCH_BOX_ID;
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  get enabled(): boolean { return Boolean(this.baseUrl && this.boxToken); }

  current(): BoxHeartbeat {
    const { authenticated, toolsReachable } = this.probe();
    return collectHeartbeat(this.db, {
      authenticated, toolsReachable,
      ownerEmail: this.ownerEmail, boxId: this.boxId,
    });
  }

  /** Send one beat. Resolves false on any failure — a missed beat is not an error. */
  async send(): Promise<boolean> {
    if (!this.enabled) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/dispatch/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-dispatch-box-token': this.boxToken! },
        body: JSON.stringify(this.current()),
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    void this.send();
    this.timer = setInterval(() => { void this.send(); }, this.intervalMs);
    // Don't hold the process open for a projection.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
