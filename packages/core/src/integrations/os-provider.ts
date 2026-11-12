import type { McpServerSpec } from '../mcp/injection.js';
import { boxLog } from '../os/box-log.js';

/**
 * Tools brokered by OS.
 *
 * A hosted box does not hold long-lived credentials for Databricks, GA4, Zendesk and
 * the rest. Instead it asks OS at EVERY spawn "what is this user entitled to, right
 * now?", and OS answers with resolved MCP server specs plus short-lived, per-user,
 * scoped tokens. Pull rather than push means:
 *   • revoking a permission in OS Admin takes effect on the next spawn, with no sync
 *   • nothing long-lived is at rest on the box
 *   • there is no drift to reconcile
 *
 * It plugs into the seam Dispatch already has — `setIntegrationsSpecs` is evaluated
 * per spawn, so this is one more spec provider rather than new machinery.
 *
 * The answer also carries the person's PROFILE (authoritative, can change at any time),
 * the connections that need a one-off consent, and `osTools`: the address of OS's own
 * MCP endpoint. The box never hands that address or its box token to a thread; a thread
 * reaches it through the daemon's loopback proxy (os/tools-proxy.ts).
 */

export type OsProfile = 'business' | 'developer';

/** One connection the person still has to consent to in OS (the "Connect <label>" card). */
export interface OsConsent { system: string; label: string; connectUrl: string }

export interface OsConnectionsResponse {
  /** MCP servers to attach for THIS project — the attached set, not everything the user may use. */
  servers: McpServerSpec[];
  /** Env the specs reference via ${VAR} placeholders (short-lived tokens live here). */
  env?: Record<string, string>;
  /** Standing instruction appended to the agent's system prompt describing the tools. */
  systemPrompt?: string | null;
  /** Connections that need a one-off user consent before they can be attached. */
  needsConsent?: Array<{ system?: string; id?: string; label?: string; connectUrl?: string }>;
  /** The granted system ids (contract 2026-11-11). An older OS sent a boolean. */
  entitled?: string[] | boolean;
  profile?: string;
  osPublicUrl?: string | null;
  osTools?: { url?: string } | null;
}

/** What the box last learned from OS, including whether the answer is trustworthy. */
export interface OsConnectionsState {
  servers: McpServerSpec[];
  env: Record<string, string>;
  systemPrompt: string | null;
  needsConsent: OsConsent[];
  /** The system ids OS grants this person (contract: `entitled`). Null until OS answered once. */
  entitled: string[] | null;
  /** OS's profile for the person. Null until OS answered (then the env DISPATCH_PROFILE applies). */
  profile: OsProfile | null;
  osPublicUrl: string | null;
  /** OS's MCP endpoint. Null: OS gives this person no company tools. */
  osTools: { url: string } | null;
  /**
   * Distinguishes "OS says you have no tools" from "OS could not be reached".
   * Collapsing these is how an outage becomes an agent that silently can't do
   * anything and can't explain why — the failure mode called out in design §4.2.1.
   */
  reachable: boolean;
  error: string | null;
  fetchedAt: string | null;
}

/** What the web page may read (GET /api/os/connections): no env, no server args, no tokens. */
export interface OsConnectionsPublic {
  hosted: boolean;
  reachable: boolean;
  error: string | null;
  fetchedAt: string | null;
  entitled: string[] | null;
  profile: OsProfile | null;
  osPublicUrl: string | null;
  osToolsEnabled: boolean;
  needsConsent: OsConsent[];
  /** Names of the MCP servers OS attached directly (not the company-system servers of os/os-servers.ts). */
  servers: string[];
}

const EMPTY: OsConnectionsState = {
  servers: [], env: {}, systemPrompt: null, needsConsent: [], entitled: null, profile: null,
  osPublicUrl: null, osTools: null, reachable: true, error: null, fetchedAt: null,
};

export interface OsConnectionsOptions {
  baseUrl?: string;
  boxToken?: string;
  ownerEmail?: string;
  /** How long a successful answer is reused. Spawns can burst; OS needn't see each one. */
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** First retry delay after a failed fetch; it doubles up to `retryMaxMs`. */
  retryMinMs?: number;
  retryMaxMs?: number;
}

function httpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? raw.trim().replace(/\/+$/, '') : null;
  } catch { return null; }
}

/** The consent list in the contract shape. `id` is the older name of `system`. Bad rows are dropped. */
export function normalizeConsent(raw: unknown): OsConsent[] {
  if (!Array.isArray(raw)) return [];
  const out: OsConsent[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const system = typeof o.system === 'string' ? o.system : typeof o.id === 'string' ? o.id : '';
    const connectUrl = typeof o.connectUrl === 'string' ? o.connectUrl : '';
    if (!system || !connectUrl) continue;
    out.push({ system, label: typeof o.label === 'string' && o.label ? o.label : system, connectUrl });
  }
  return out;
}

export class OsConnectionsProvider {
  private state: OsConnectionsState = { ...EMPTY };
  private inFlight: Promise<void> | null = null;
  private readonly baseUrl?: string;
  private readonly boxToken?: string;
  private readonly ownerEmail?: string;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;
  private retryTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private retryDelay: number;
  private stopped = false;
  private listeners = new Set<(s: OsConnectionsState, prev: OsConnectionsState) => void>();

  constructor(opts: OsConnectionsOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.OS_BASE_URL)?.replace(/\/+$/, '') || undefined;
    this.boxToken = opts.boxToken ?? process.env.OS_BOX_TOKEN;
    this.ownerEmail = opts.ownerEmail ?? process.env.DISPATCH_OWNER_EMAIL;
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.retryMinMs = opts.retryMinMs ?? 5_000;
    this.retryMaxMs = opts.retryMaxMs ?? 60_000;
    this.retryDelay = this.retryMinMs;
  }

  /** True when this daemon is configured to broker tools from OS at all. */
  get enabled(): boolean { return Boolean(this.baseUrl && this.boxToken); }

  /** The headers that authenticate the box to OS. Never handed to a thread. */
  boxHeaders(): Record<string, string> {
    if (!this.boxToken) return {};
    return { 'x-dispatch-box-token': this.boxToken, ...(this.ownerEmail ? { 'x-dispatch-owner': this.ownerEmail } : {}) };
  }

  snapshot(): OsConnectionsState { return { ...this.state }; }

  publicSnapshot(): OsConnectionsPublic {
    const s = this.state;
    return {
      hosted: this.enabled, reachable: s.reachable, error: s.error, fetchedAt: s.fetchedAt, entitled: s.entitled,
      profile: s.profile, osPublicUrl: s.osPublicUrl, osToolsEnabled: !!s.osTools, needsConsent: s.needsConsent,
      servers: s.servers.map((x) => x.name),
    };
  }

  /** Called after every refresh whose result differs (profile, reachability, consent, tools, env, prompt). Returns an unsubscribe. */
  onChange(fn: (s: OsConnectionsState, prev: OsConnectionsState) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /**
   * Specs for the current spawn. Synchronous by necessity — `setIntegrationsSpecs`
   * is a sync callback — so this serves the cached answer and refreshes in the
   * background. The first spawn after boot may therefore have no OS tools; `refresh()`
   * is called once at startup to make that window small.
   */
  getServerSpecs(): McpServerSpec[] {
    if (!this.enabled) return [];
    // Stale, or OS was not reachable at the last try: ask again now (coalesced, 5 s timeout). This
    // spawn still gets the cache; a company-system server lists its tools live when the thread starts.
    if (this.isStale() || !this.state.reachable) void this.refresh();
    return this.state.servers;
  }

  /** Env the specs' ${VAR} placeholders resolve against (short-lived tokens). */
  getSpawnEnv(): Record<string, string> {
    return this.enabled ? this.state.env : {};
  }

  getSystemPrompt(): string | null {
    return this.enabled ? this.state.systemPrompt : null;
  }

  /** OS's MCP endpoint, or null (not hosted, or OS gives no company tools). */
  osToolsUrl(): string | null {
    return this.enabled ? this.state.osTools?.url ?? null : null;
  }

  private isStale(): boolean {
    if (!this.state.fetchedAt) return true;
    return Date.now() - Date.parse(this.state.fetchedAt) > this.ttlMs;
  }

  /** Fetch the entitled+attached tool set. Never throws — it must not break a spawn. */
  async refresh(): Promise<OsConnectionsState> {
    if (!this.enabled) return this.snapshot();
    if (this.inFlight) { await this.inFlight; return this.snapshot(); }

    const run = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/api/dispatch/connections`, {
          method: 'GET',
          headers: this.boxHeaders(),
          signal: controller.signal,
        });
        if (!res.ok) {
          this.markUnreachable(`OS returned ${res.status}`);
          this.logResult(res.status);
          return;
        }
        const body = (await res.json()) as OsConnectionsResponse;
        const profile = body?.profile === 'business' || body?.profile === 'developer' ? body.profile : null;
        const toolsUrl = httpUrl(body?.osTools?.url);
        this.set({
          servers: Array.isArray(body?.servers) ? body.servers : [],
          env: body?.env && typeof body.env === 'object' ? body.env : {},
          systemPrompt: typeof body?.systemPrompt === 'string' && body.systemPrompt.trim() ? body.systemPrompt : null,
          needsConsent: normalizeConsent(body?.needsConsent),
          entitled: Array.isArray(body?.entitled) ? body.entitled.filter((x): x is string => typeof x === 'string') : null,
          // An answer without a profile keeps the one we had (an older OS build).
          profile: profile ?? this.state.profile,
          osPublicUrl: httpUrl(body?.osPublicUrl) ?? this.state.osPublicUrl,
          osTools: toolsUrl ? { url: toolsUrl } : null,
          reachable: true,
          error: null,
          fetchedAt: new Date().toISOString(),
        });
        this.retryDelay = this.retryMinMs;
        this.logResult();
      } catch (err: any) {
        this.markUnreachable(err?.name === 'AbortError' ? `no answer from OS within ${this.timeoutMs} ms` : err?.message || 'request failed');
        this.logResult();
      } finally {
        clearTimeout(timer);
      }
    })();

    this.inFlight = run;
    try { await run; } finally { this.inFlight = null; }
    return this.snapshot();
  }

  /**
   * Record that a call to OS (the connections fetch, or a tools call through the proxy) failed.
   * Keep the last good specs but flag the outage. Dropping them would silently
   * disarm every agent the moment OS hiccups; keeping them stale is the lesser
   * evil, and `reachable:false` lets the UI say so. A retry runs in the background.
   */
  markUnreachable(error: string): void {
    this.set({ ...this.state, reachable: false, error });
    this.scheduleRetry();
  }

  /**
   * Ask OS again every `ttlMs` (default 60 s) while the daemon runs, so a change made in OS (the
   * profile above all, also consent and tools) arrives without waiting for a spawn. One small GET per
   * minute; a failure only marks the state unreachable and keeps the last answer.
   */
  startPolling(): void {
    if (!this.enabled || this.pollTimer || this.stopped) return;
    this.pollTimer = setInterval(() => { void this.refresh(); }, this.ttlMs);
    this.pollTimer.unref?.();
  }

  /** Stop the background retry and the poll (daemon stop). */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer || !this.enabled) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, this.retryMaxMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.refresh();
    }, delay);
    this.retryTimer.unref?.();
  }

  /** The last line the box log got for a fetch: a poll with the same answer writes no new line. */
  private lastLogged = '';
  private logResult(status?: number): void {
    const st = this.state;
    const fields = st.reachable
      ? { reachable: true, servers: st.servers.length, needsConsent: st.needsConsent.length, entitled: st.entitled?.length ?? null, profile: st.profile, osTools: !!st.osTools }
      : { reachable: false, ...(status ? { status } : {}), error: st.error ?? 'unknown', servers: st.servers.length };
    const key = JSON.stringify(fields);
    if (key === this.lastLogged) return;
    this.lastLogged = key;
    boxLog('os.connections', fields, st.reachable ? 'info' : 'warn');
  }

  private set(next: OsConnectionsState): void {
    const prev = this.state;
    this.state = next;
    const changed = prev.reachable !== next.reachable || prev.profile !== next.profile || JSON.stringify(prev.entitled) !== JSON.stringify(next.entitled)
      || (prev.osTools?.url ?? null) !== (next.osTools?.url ?? null)
      || JSON.stringify(prev.needsConsent) !== JSON.stringify(next.needsConsent)
      || prev.systemPrompt !== next.systemPrompt
      || JSON.stringify(prev.servers) !== JSON.stringify(next.servers)
      || JSON.stringify(prev.env) !== JSON.stringify(next.env);
    if (!changed) return;
    for (const fn of this.listeners) {
      try { fn(this.snapshot(), prev); } catch { /* a listener never breaks a refresh */ }
    }
  }
}
