import type { McpServerSpec } from '../mcp/injection.js';

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
 */

export interface OsConnectionsResponse {
  /** MCP servers to attach for THIS project — the attached set, not everything the user may use. */
  servers: McpServerSpec[];
  /** Env the specs reference via ${VAR} placeholders (short-lived tokens live here). */
  env?: Record<string, string>;
  /** Standing instruction appended to the agent's system prompt describing the tools. */
  systemPrompt?: string | null;
  /** Connections that need a one-off user consent before they can be attached. */
  needsConsent?: Array<{ id: string; label: string; connectUrl: string }>;
}

/** What the box last learned from OS, including whether the answer is trustworthy. */
export interface OsConnectionsState {
  servers: McpServerSpec[];
  env: Record<string, string>;
  systemPrompt: string | null;
  needsConsent: Array<{ id: string; label: string; connectUrl: string }>;
  /**
   * Distinguishes "OS says you have no tools" from "OS could not be reached".
   * Collapsing these is how an outage becomes an agent that silently can't do
   * anything and can't explain why — the failure mode called out in design §4.2.1.
   */
  reachable: boolean;
  error: string | null;
  fetchedAt: string | null;
}

const EMPTY: OsConnectionsState = {
  servers: [], env: {}, systemPrompt: null, needsConsent: [],
  reachable: true, error: null, fetchedAt: null,
};

export interface OsConnectionsOptions {
  baseUrl?: string;
  boxToken?: string;
  ownerEmail?: string;
  /** How long a successful answer is reused. Spawns can burst; OS needn't see each one. */
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
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

  constructor(opts: OsConnectionsOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.OS_BASE_URL)?.replace(/\/+$/, '') || undefined;
    this.boxToken = opts.boxToken ?? process.env.OS_BOX_TOKEN;
    this.ownerEmail = opts.ownerEmail ?? process.env.DISPATCH_OWNER_EMAIL;
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  /** True when this daemon is configured to broker tools from OS at all. */
  get enabled(): boolean { return Boolean(this.baseUrl && this.boxToken); }

  snapshot(): OsConnectionsState { return { ...this.state }; }

  /**
   * Specs for the current spawn. Synchronous by necessity — `setIntegrationsSpecs`
   * is a sync callback — so this serves the cached answer and refreshes in the
   * background. The first spawn after boot may therefore have no OS tools; `refresh()`
   * is called once at startup to make that window small.
   */
  getServerSpecs(): McpServerSpec[] {
    if (!this.enabled) return [];
    if (this.isStale()) void this.refresh();
    return this.state.servers;
  }

  /** Env the specs' ${VAR} placeholders resolve against (short-lived tokens). */
  getSpawnEnv(): Record<string, string> {
    return this.enabled ? this.state.env : {};
  }

  getSystemPrompt(): string | null {
    return this.enabled ? this.state.systemPrompt : null;
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
          headers: {
            'x-dispatch-box-token': this.boxToken!,
            ...(this.ownerEmail ? { 'x-dispatch-owner': this.ownerEmail } : {}),
          },
          signal: controller.signal,
        });
        if (!res.ok) {
          this.markUnreachable(`OS returned ${res.status}`);
          return;
        }
        const body = (await res.json()) as OsConnectionsResponse;
        this.state = {
          servers: Array.isArray(body?.servers) ? body.servers : [],
          env: body?.env ?? {},
          systemPrompt: body?.systemPrompt ?? null,
          needsConsent: body?.needsConsent ?? [],
          reachable: true,
          error: null,
          fetchedAt: new Date().toISOString(),
        };
      } catch (err: any) {
        this.markUnreachable(err?.message || 'request failed');
      } finally {
        clearTimeout(timer);
      }
    })();

    this.inFlight = run;
    try { await run; } finally { this.inFlight = null; }
    return this.snapshot();
  }

  /**
   * Keep the last good specs but flag the outage. Dropping them would silently
   * disarm every agent the moment OS hiccups; keeping them stale is the lesser
   * evil, and `reachable:false` lets the UI say so.
   */
  private markUnreachable(error: string): void {
    this.state = { ...this.state, reachable: false, error };
  }
}
