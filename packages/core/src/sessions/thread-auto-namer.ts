import fs from 'fs';
import { isAgentType } from '../providers/agent-types.js';
import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { cleanName, deriveThreadRaw, resolveTranscriptPath, userPromptText, fallbackThreadName } from './thread-namer.js';
import { generateThreadName } from './model-namer.js';
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
  /**
   * Resolves the OpenRouter API key (the OpenCode key from Doppler, by configured
   * name). Absent or resolving to null → prefix-derived names only, exactly the
   * pre-model behavior. Resolved PER ATTEMPT, not cached here, so connecting
   * Doppler / saving a key upgrades naming without a restart.
   */
  getApiKey?: () => Promise<string | null>;
  /** Injectable model-title generator, for tests. Default: model-namer's generateThreadName. */
  generateModelName?: (apiKey: string, conversationText: string) => Promise<string | null>;
}

/**
 * One-shot naming from a durable first user prompt, for every registered harness.
 * Direct submissions start immediately and have a three-second model/key budget.
 * Transcript activity is a fallback for raw CLI interactions we cannot capture.
 * The SQL label-source guard lets manual renames win, including in-flight races.
 */
export class ThreadAutoNamer {
  private readonly db: Database.Database;
  private readonly broadcaster?: EventBroadcaster;
  private readonly delayMs: number;
  private readonly maxAttempts: number;
  private readonly readFile: (p: string) => Promise<string>;
  private readonly getApiKey?: () => Promise<string | null>;
  private readonly generateModelName: (apiKey: string, conversationText: string) => Promise<string | null>;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  private readonly inFlight = new Set<string>();
  private readonly attempts = new Map<string, number>();

  constructor(db: Database.Database, broadcaster?: EventBroadcaster, opts?: ThreadAutoNamerOptions) {
    this.db = db;
    this.broadcaster = broadcaster;
    this.delayMs = opts?.delayMs ?? 5000;
    this.maxAttempts = opts?.maxAttempts ?? 3;
    this.readFile = opts?.readFile ?? ((p: string) => fs.promises.readFile(p, 'utf-8'));
    this.getApiKey = opts?.getApiKey;
    this.generateModelName = opts?.generateModelName ?? generateThreadName;
  }

  /** Capture the first submitted human prompt before any harness adds setup context. */
  notifyPrompt(terminalId: string, content: string): void {
    if (this.disposed || !this.db.open) return;
    const row = terminalsDb.getById(this.db, terminalId);
    if (!row || row.label_source !== 'default' || !isAgentType(row.type)) return;
    const prompt = userPromptText(content).slice(0, 4000);
    if (!cleanName(prompt)) return;
    this.db.prepare('INSERT OR IGNORE INTO thread_naming_prompts VALUES (?,?)').run(terminalId, prompt);
    if (this.inFlight.has(terminalId)) return;
    const pending = this.timers.get(terminalId);
    if (pending) clearTimeout(pending);
    // No debounce, transcript, or native session-ID prerequisite on a user send.
    const timer = setTimeout(() => { void this.attempt(terminalId); }, 0);
    timer.unref();
    this.timers.set(terminalId, timer);
  }

  resumePending(): void {
    for (const row of this.db.prepare(`SELECT p.terminal_id, p.prompt FROM thread_naming_prompts p
      JOIN terminals t ON t.id=p.terminal_id WHERE t.label_source='default' AND t.archived_at IS NULL`).all() as { terminal_id: string; prompt: string }[]) {
      this.notifyPrompt(row.terminal_id, row.prompt);
    }
  }

  /** Call on every real-activity moment. Cheap; self-filters. */
  notifyActivity(terminalId: string): void {
    try {
      if (this.disposed || !this.db.open) return;
      if (this.timers.has(terminalId)) return; // already scheduled or attempt in flight
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
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private bumpAttempts(terminalId: string): void {
    this.attempts.set(terminalId, (this.attempts.get(terminalId) ?? 0) + 1);
  }

  private async attempt(terminalId: string): Promise<void> {
    // The `timers` entry is deliberately NOT removed here: it doubles as an
    // in-flight marker for the WHOLE async span of this attempt, not just the
    // wait-for-the-debounce-timer span. notifyActivity's `timers.has` guard
    // must keep blocking until this attempt fully settles (finally, below) —
    // otherwise a notify arriving mid-await would schedule a second concurrent
    // attempt for the same terminal.
    this.inFlight.add(terminalId);
    try {
      const row = terminalsDb.getById(this.db, terminalId);
      if (!row || row.label_source !== 'default') return; // renamed/relabeled since scheduling
      const saved = this.db.prepare('SELECT prompt FROM thread_naming_prompts WHERE terminal_id=?').get(terminalId) as { prompt: string } | undefined;
      let raw = saved?.prompt ?? '';
      if (!raw) {
        const kind = KIND_BY_TYPE[row.type];
        if (!kind || !row.external_id) return;
        const session = sessionsDb.getById(this.db, row.session_id);
        const transcriptPath = await resolveTranscriptPath(
          { type: row.type, externalId: row.external_id, workingDir: row.working_dir },
          session?.working_dir ?? row.working_dir ?? '',
        );
        if (!transcriptPath) { this.bumpAttempts(terminalId); return; }
        try { raw = deriveThreadRaw(await this.readFile(transcriptPath), kind); }
        catch { this.bumpAttempts(terminalId); return; }
        // A human send may have arrived while reading the transcript. It wins.
        const submitted = this.db.prepare('SELECT prompt FROM thread_naming_prompts WHERE terminal_id=?').get(terminalId) as { prompt: string } | undefined;
        raw = submitted?.prompt ?? raw;
      }
      const fallback = fallbackThreadName(raw);
      if (!fallback) {
        this.bumpAttempts(terminalId);
        console.debug('[thread-auto-namer] giving up on terminal', terminalId, 'no derivable name');
        return;
      }

      // Model upgrade: when an OpenRouter key resolves, ask GLM for a 3-5 word
      // title from the FULL prompt text (`raw`, not the 48-char `fallback`).
      // Every failure path — no resolver, no key, model error/timeout — lands on
      // the prefix-derived fallback, which is exactly the pre-model behavior.
      // The await is safe against double-naming: the `timers` entry blocks
      // re-entry for this terminal until `finally` below, and setAutoLabel's
      // label_source='default' SQL guard still lets a concurrent user rename win.
      let name = fallback;
      if (this.getApiKey) {
        let expired = false;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          name = await Promise.race([
            (async () => {
              const key = await this.getApiKey!();
              if (!key || expired || this.disposed) return fallback;
              return cleanName((await this.generateModelName(key, raw)) ?? '') ?? fallback;
            })(),
            new Promise<string>((resolve) => {
              deadline = setTimeout(() => { expired = true; resolve(fallback); }, 3000);
              deadline.unref?.();
            }),
          ]);
        } catch { /* use the prompt fallback */ }
        finally { if (deadline) clearTimeout(deadline); }
      }
      if (this.disposed || !this.db.open) return;

      const applied = terminalsDb.setAutoLabel(this.db, terminalId, name);
      if (!applied) return; // a user rename won the race

      this.broadcaster?.broadcast({ type: 'session:tabs-changed', sessionId: row.session_id });
    } catch (err) {
      this.bumpAttempts(terminalId);
      console.debug('[ThreadAutoNamer] attempt failed', terminalId, err);
    } finally {
      this.timers.delete(terminalId);
      this.inFlight.delete(terminalId);
    }
  }
}
