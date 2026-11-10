import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { codexRolloutTailStatus } from './codex-sessions.js';
import { transcriptTailStatus } from './cc-sessions.js';
import type { ThreadConfigStore } from './thread-config.js';

type IStructuredManager = import('../structured/manager.js').IStructuredManager;

/** Grace period before the boot kickstart runs, so a save-burst on shutdown can coalesce. */
const KICKSTART_SETTLE_MS = 4000;

/** The re-prompt delivered to a structured thread that the last daemon shutdown interrupted mid-turn. */
const KICKSTART_CONTINUE_PROMPT =
  '⚙️ Dispatch restarted and interrupted you mid-task — re-read your last steps above and continue your ' +
  'mission from where you left off. If you had already finished, briefly say so instead of redoing work.';

/** The boot kickstart resumes only structured overseer threads: the coordinator and its typed agents. */
function isKickstartCandidate(config: Record<string, any>): boolean {
  return config.transport === 'structured' && (config.role === 'coordinator' || config.role === 'agent');
}

/** What BootRecovery needs. Every field is required. */
export interface BootRecoveryDeps {
  db: Database.Database;
  /** The one writer of a thread's config. */
  configStore: ThreadConfigStore;
  /** The thread operations that the kickstart uses. SessionService gives its own methods. */
  threads: {
    structuredManagerFor(type: string): IStructuredManager | undefined;
    /** Starts the thread if it is dead, then sends the text (the facade send, so an override is reached). */
    sendStructuredMessage(terminalId: string, content: string): void;
  };
}

/**
 * The recovery from the last daemon shutdown (W3-B: moved out of SessionService): the boot
 * kickstart of the overseer threads that the shutdown interrupted mid-turn, and the shutdown that
 * keeps those turns marked as interrupted for the next boot.
 */
export class BootRecovery {
  constructor(private readonly deps: BootRecoveryDeps) {}

  // The inputs under the names the moved code uses.
  private get db(): Database.Database { return this.deps.db; }
  private get configStore(): ThreadConfigStore { return this.deps.configStore; }
  private structuredManagerFor(type: string): IStructuredManager | undefined { return this.deps.threads.structuredManagerFor(type); }
  private sendStructuredMessage(terminalId: string, content: string): void { return this.deps.threads.sendStructuredMessage(terminalId, content); }

  /**
   * One-shot boot recovery: auto-resume overseer threads (the coordinator and its
   * typed agents) that the last daemon shutdown interrupted mid-turn. The signal is
   * free — a non-archived structured terminal still in `status='working'` at boot
   * died mid-turn (clean shutdown skips the settle-to-`waiting` write, and
   * clearStalePids only touches sessions). Kicking is a single sendStructuredMessage:
   * it revives the thread (spawn/`-r` + transcript backfill) AND re-prompts it to
   * continue.
   *
   * Idempotency (so a restart-during-recovery doesn't double-prompt or make a
   * finished agent redo work):
   *   - skip a thread whose transcript tail shows a COMPLETED turn — the shutdown
   *     race left it stale-`working` but it actually finished;
   *   - skip a thread already stamped `config.kickedAt` with no newer transcript
   *     activity since (we kicked it on a prior boot and it hasn't moved).
   * Each kicked thread is stamped `config.kickedAt` afterwards. `completed` names the threads
   * skipped because their turn completed: no settle edge ever fires for them (Endless Chat
   * reports its own threads among them, final review M-5).
   *
   * DEFERRED (follow-up): `needs_input` agents lose their in-memory pending on
   * restart. They aren't `working`, so this kicker correctly skips them — reviving
   * them needs a different path (re-surface the question), not a mid-task nudge.
   *
   * CLAUDE + CODEX: `terminalsDb.listWorkingStructured` scopes this to the harnesses with a
   * local record of the turn for the idempotency check — the claude JSONL transcript
   * (transcriptTailStatus) and the Codex rollout (codexRolloutTailStatus). Grok/OpenCode have
   * none, so they are never proactively boot-kicked and rely on `ensureStructuredAlive`
   * (revive-on-open). Pinned in coordinator-restart.test.ts.
   */
  async kickstartInterruptedAgents(settleMs: number = KICKSTART_SETTLE_MS): Promise<{ kicked: string[]; skipped: string[]; completed: string[] }> {
    const kicked: string[] = [];
    const skipped: string[] = [];
    /** Skipped because the record shows the turn completed: the turn ended while no one listened. */
    const completed: string[] = [];
    if (!this.structuredManagerFor('claude-code') && !this.structuredManagerFor('codex')) return { kicked, skipped, completed };

    // (a) Settle: let any burst of save writes from the shutdown coalesce before we read status.
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));

    // (b) Enumerate every non-archived claude-code/codex terminal left `working` across all sessions.
    const rows = terminalsDb.listWorkingStructured(this.db);
    for (const row of rows) {
      if (!this.structuredManagerFor(row.type)) { skipped.push(row.id); continue; }
      let config: Record<string, any> = {};
      try { config = JSON.parse(row.config || '{}'); } catch { skipped.push(row.id); continue; }
      // Structured overseer threads only: the coordinator and its typed agents.
      if (!isKickstartCandidate(config)) { skipped.push(row.id); continue; }

      // The shutdown's interruptedAt stamp (see shutdownPreservingInterruptedTurns) is good for
      // THIS boot only: consume it whether the row is kicked or skipped, so it never goes stale.
      const interruptedByShutdown = typeof config.interruptedAt === 'string';
      if (config.interruptedAt !== undefined) {
        delete config.interruptedAt;
        this.configStore.patch(row.id, { interruptedAt: null });
      }

      // (c) Idempotency. Compare against the thread's own record of the turn, which advances as
      // it works: the claude transcript, or the Codex rollout (keyed by the thread id).
      const session = sessionsDb.getById(this.db, row.session_id);
      const workDir = row.working_dir || session?.working_dir || null;
      const tail = !row.external_id
        ? null
        : row.type === 'codex'
          ? codexRolloutTailStatus(row.external_id)
          : (workDir ? transcriptTailStatus(workDir, row.external_id) : null);

      // Already kicked on a prior boot and nothing new happened since → don't re-prompt.
      const kickedAt = typeof config.kickedAt === 'string' ? Date.parse(config.kickedAt) : NaN;
      if (!Number.isNaN(kickedAt) && (!tail || tail.mtimeMs <= kickedAt)) { skipped.push(row.id); continue; }

      // The turn actually completed (shutdown race left it stale-working) → nothing to resume.
      // Except a Codex `turn_aborted` on a thread the last graceful shutdown interrupted
      // (interruptedAt, stamped by shutdownPreservingInterruptedTurns): Codex writes that marker
      // when its app-server gets SIGTERM mid-turn, so there it IS the cut-off turn, not a Stop.
      const cutByShutdown = interruptedByShutdown && !!tail && 'aborted' in tail && tail.aborted;
      if (tail?.completed && !cutByShutdown) { skipped.push(row.id); completed.push(row.id); continue; }

      // (d) Kick (revive + re-prompt) and stamp so a later restart won't double-kick.
      try {
        this.sendStructuredMessage(row.id, KICKSTART_CONTINUE_PROMPT);
        // Only the stamp: the send above started the thread, and the start saved keys (the
        // resolved model, the tools list) that the copy read before the loop does not have.
        this.configStore.patch(row.id, { kickedAt: new Date().toISOString() });
        kicked.push(row.id);
      } catch {
        skipped.push(row.id);
      }
    }
    return { kicked, skipped, completed };
  }

  /**
   * The shutdown half of the boot kickstart. Runs `stopAll` (the daemon's manager killAll calls),
   * then writes `working` back onto every overseer thread that was mid-turn before it, and stamps
   * it `interruptedAt`, so the next boot's kickstartInterruptedAgents finds it and knows the
   * shutdown cut its turn (see the Codex `turn_aborted` case there). Returns the restored ids.
   *
   * Needed because both structured managers emit `exit` SYNCHRONOUSLY from kill(): the status
   * service settles the row to `waiting` right there, before the daemon's db.close() — so without
   * this, a graceful restart (`dispatch restart` / `update`, SIGTERM) dropped the interrupted turn.
   * Everything else about the exit (roles close-out, pid clear) still happens.
   */
  shutdownPreservingInterruptedTurns(stopAll: () => void): string[] {
    const interrupted = terminalsDb.listWorkingStructured(this.db)
      .filter((row) => {
        try { return isKickstartCandidate(JSON.parse(row.config || '{}')); } catch { return false; }
      })
      .map((row) => row.id);
    stopAll();
    const interruptedAt = new Date().toISOString();
    for (const id of interrupted) {
      terminalsDb.updateStatus(this.db, id, 'working');
      // A patch of the one key: the kill's own exit handling may have written config (e.g. a turn outcome).
      // The stamp tells the kickstart this thread's turn was cut off by the shutdown — Codex
      // records that as `turn_aborted`, which otherwise reads as a deliberate Stop.
      try {
        this.configStore.patch(id, { interruptedAt });
      } catch { /* best effort: the row stays `working`, which alone kicks a task_started tail */ }
    }
    return interrupted;
  }
}
