import fs from 'fs';
import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { deriveThreadName, resolveTranscriptPath } from './thread-namer.js';
import type { EventBroadcaster } from '../ws/events.js';

/** Terminal types eligible for auto-naming, mapped to thread-namer's transcript kind. */
const KIND_BY_TYPE: Record<string, 'claude' | 'codex'> = {
  'claude-code': 'claude',
  codex: 'codex',
};

export interface ThreadAutoNamerOptions {
  /** Debounce delay before attempting a name, in ms. Default 5000. */
  delayMs?: number;
  /** Max failed attempts (missing/unreadable transcript, no derivable name) before giving up. Default 3. */
  maxAttempts?: number;
  /** Injectable transcript reader, for tests. Default: fs.promises.readFile(p, 'utf-8'). */
  readFile?: (p: string) => Promise<string>;
}

/**
 * Debounced, one-shot, best-effort auto-namer for `default`-labeled claude-code/codex
 * threads. `notifyActivity` is meant to be called on every real-activity moment
 * (cheap — it self-filters and no-ops for ineligible/already-scheduled/already-named
 * terminals). After `delayMs` of no further activity it reads the terminal's
 * transcript, derives a name, and writes it via `terminalsDb.setAutoLabel`, whose
 * `label_source = 'default'` guard means a concurrent user rename always wins (the
 * write becomes a no-op, silently). Failures (missing transcript, unparseable
 * transcript, no derivable name) count against a small attempt cap so a thread that
 * can never be named doesn't get retried forever; success or a user-won race both stop
 * further scheduling naturally since the row is no longer `label_source: 'default'`.
 */
export class ThreadAutoNamer {
  private readonly db: Database.Database;
  private readonly broadcaster?: EventBroadcaster;
  private readonly delayMs: number;
  private readonly maxAttempts: number;
  private readonly readFile: (p: string) => Promise<string>;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<string, number>();

  constructor(db: Database.Database, broadcaster?: EventBroadcaster, opts?: ThreadAutoNamerOptions) {
    this.db = db;
    this.broadcaster = broadcaster;
    this.delayMs = opts?.delayMs ?? 5000;
    this.maxAttempts = opts?.maxAttempts ?? 3;
    this.readFile = opts?.readFile ?? ((p: string) => fs.promises.readFile(p, 'utf-8'));
  }

  /** Call on every real-activity moment. Cheap; self-filters. */
  notifyActivity(terminalId: string): void {
    try {
      if (this.timers.has(terminalId)) return; // already scheduled
      if ((this.attempts.get(terminalId) ?? 0) >= this.maxAttempts) return; // gave up

      const row = terminalsDb.getById(this.db, terminalId);
      if (!row || row.label_source !== 'default') return;
      if (!KIND_BY_TYPE[row.type]) return;

      const timer = setTimeout(() => {
        void this.attempt(terminalId);
      }, this.delayMs);
      timer.unref();
      this.timers.set(terminalId, timer);
    } catch (err) {
      console.debug('[ThreadAutoNamer] notifyActivity failed', terminalId, err);
    }
  }

  /** Clears all pending timers. Good hygiene for tests / shutdown. */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private bumpAttempts(terminalId: string): void {
    this.attempts.set(terminalId, (this.attempts.get(terminalId) ?? 0) + 1);
  }

  private async attempt(terminalId: string): Promise<void> {
    this.timers.delete(terminalId);
    try {
      const row = terminalsDb.getById(this.db, terminalId);
      if (!row || row.label_source !== 'default') return; // renamed/relabeled since scheduling
      const kind = KIND_BY_TYPE[row.type];
      if (!kind) return;

      const session = sessionsDb.getById(this.db, row.session_id);
      const sessionWorkingDir = session?.working_dir ?? row.working_dir ?? '';

      const transcriptPath = await resolveTranscriptPath(
        { type: row.type, externalId: row.external_id, workingDir: row.working_dir },
        sessionWorkingDir,
      );
      if (!transcriptPath) {
        this.bumpAttempts(terminalId);
        return;
      }

      let text: string;
      try {
        text = await this.readFile(transcriptPath);
      } catch {
        this.bumpAttempts(terminalId);
        return;
      }

      const name = deriveThreadName(text, kind);
      if (!name) {
        this.bumpAttempts(terminalId);
        return;
      }

      const applied = terminalsDb.setAutoLabel(this.db, terminalId, name);
      if (!applied) return; // a user rename won the race

      this.broadcaster?.broadcast({ type: 'session:tabs-changed', sessionId: row.session_id });
    } catch (err) {
      this.bumpAttempts(terminalId);
      console.debug('[ThreadAutoNamer] attempt failed', terminalId, err);
    }
  }
}
