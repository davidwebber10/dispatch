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

  markComplete(id: string): AuthRequestRecord | null {
    return this.updateStatus(id, 'completed');
  }

  async forwardLoopbackCallback(id: string, callbackUrl: string): Promise<AuthRequestRecord | null> {
    const record = this.requests.get(id);
    if (!record) return null;

    const parsed = this.parseHttpUrl(callbackUrl);
    if (!this.isLoopbackHost(parsed.hostname)) {
      throw new Error('Callback forwarding only supports loopback URLs');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      await this.fetchImpl(parsed.toString(), { method: 'GET', redirect: 'manual', signal: controller.signal });
      return this.updateStatus(id, 'callback_forwarded');
    } catch (err: any) {
      return this.updateStatus(id, 'error', err?.message || 'Callback forwarding failed');
    } finally {
      clearTimeout(timeout);
    }
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
