import { v4 as uuid } from 'uuid';
import type { EventBroadcaster } from '../ws/events.js';

export type AuthRequestStatus = 'pending' | 'opened' | 'callback_forwarded' | 'completed' | 'error';

export interface AuthRequestRecord {
  id: string;
  url: string;
  source: string;
  terminalId: string | null;
  cwd: string | null;
  status: AuthRequestStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AuthRequestServiceDeps {
  fetch?: typeof fetch;
  now?: () => Date;
}

const MAX_RETAINED_AUTH_REQUESTS = 100;

export class AuthRequestService {
  private requests = new Map<string, AuthRequestRecord>();
  private fetchImpl: typeof fetch;
  private now: () => Date;
  private lastTimestampMs = 0;

  constructor(private broadcaster: EventBroadcaster, deps: AuthRequestServiceDeps = {}) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? (() => new Date());
  }

  create(input: { url: string; source?: string; terminalId?: string; cwd?: string }): AuthRequestRecord {
    const parsed = this.parseHttpUrl(input.url);
    const timestamp = this.nextTimestamp();
    const record: AuthRequestRecord = {
      id: uuid(),
      url: parsed.toString(),
      source: input.source || 'browser-env',
      terminalId: input.terminalId || null,
      cwd: input.cwd || null,
      status: 'pending',
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    // A CLI that restarts mid-sign-in (an MCP reconnect, a startup timeout) opens a fresh
    // authorize URL with a new state, and its old callback listener is gone. The older banner
    // can then only fail, so retire it: same terminal + same authorize endpoint = superseded.
    if (record.terminalId) {
      const endpoint = parsed.origin + parsed.pathname;
      for (const r of this.requests.values()) {
        if (r.terminalId !== record.terminalId || (r.status !== 'pending' && r.status !== 'opened')) continue;
        const prev = new URL(r.url);
        if (prev.origin + prev.pathname === endpoint) this.markComplete(r.id);
      }
    }

    this.requests.set(record.id, record);
    this.pruneOldestIfNeeded();
    this.broadcast('auth:request', record);
    return record;
  }

  list(): AuthRequestRecord[] {
    this.pruneOldestIfNeeded();
    return [...this.requests.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): AuthRequestRecord | null {
    return this.requests.get(id) ?? null;
  }

  markOpened(id: string): AuthRequestRecord | null {
    return this.updateStatus(id, 'opened');
  }

  /**
   * Complete every outstanding request at once. The banner shows one at a time, so a burst
   * of them meant one dismissal each — five taps to clear five. Dismiss now means dismiss.
   */
  completeAll(): AuthRequestRecord[] {
    const done: AuthRequestRecord[] = [];
    for (const r of this.requests.values()) {
      if (r.status === 'pending' || r.status === 'opened') {
        const updated = this.markComplete(r.id);
        if (updated) done.push(updated);
      }
    }
    return done;
  }

  markComplete(id: string): AuthRequestRecord | null {
    return this.updateStatus(id, 'completed');
  }

  async forwardLoopbackCallback(id: string, callbackUrl: string): Promise<AuthRequestRecord | null> {
    const record = this.requests.get(id);
    if (!record) return null;

    // Safari's address bar copies `localhost:39461/callback?…` with no scheme, which URL reads
    // as scheme "localhost:". A loopback callback is always plain http, so supply it.
    const trimmed = callbackUrl.trim();
    const parsed = this.parseHttpUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    if (!this.isLoopbackHost(parsed.hostname)) {
      throw new Error('Callback forwarding only supports loopback URLs');
    }

    // A failure throws rather than marking the request 'error': that status hid the banner,
    // so a bad paste just made it vanish. Left open, the banner shows why and takes a retry.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let res: Response;
    try {
      res = await this.fetchImpl(parsed.toString(), { method: 'GET', redirect: 'manual', signal: controller.signal });
    } catch {
      throw new Error('That sign-in is no longer waiting on this Mac (the CLI restarted). Open the newest sign-in link and try again.');
    } finally {
      clearTimeout(timeout);
    }
    if (res.status >= 400) {
      const detail = (await res.text().catch(() => '')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
      throw new Error(`The CLI rejected the callback (${res.status})${detail ? `: ${detail}` : ''}`);
    }
    return this.updateStatus(id, 'callback_forwarded');
  }

  private updateStatus(id: string, status: AuthRequestStatus, error: string | null = null): AuthRequestRecord | null {
    const existing = this.requests.get(id);
    if (!existing) return null;

    const updated: AuthRequestRecord = {
      ...existing,
      status,
      error,
      updatedAt: this.nextTimestamp(),
    };
    this.requests.set(id, updated);
    this.pruneOldestIfNeeded();
    this.broadcast('auth:updated', updated);
    return updated;
  }

  private pruneOldestIfNeeded(): void {
    if (this.requests.size <= MAX_RETAINED_AUTH_REQUESTS) return;

    const oldestIds = [...this.requests.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, this.requests.size - MAX_RETAINED_AUTH_REQUESTS)
      .map((request) => request.id);

    for (const id of oldestIds) {
      this.requests.delete(id);
    }
  }

  private nextTimestamp(): string {
    const nowMs = this.now().getTime();
    const timestampMs = Math.max(nowMs, this.lastTimestampMs + 1);
    this.lastTimestampMs = timestampMs;
    return new Date(timestampMs).toISOString();
  }

  private parseHttpUrl(raw: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error('Invalid URL');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Invalid URL protocol');
    }

    return parsed;
  }

  private isLoopbackHost(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  }

  private broadcast(type: 'auth:request' | 'auth:updated', request: AuthRequestRecord): void {
    this.broadcaster.broadcast({ type, request });
  }
}
