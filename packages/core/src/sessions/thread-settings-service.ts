import { codexDefaultEffort } from '../structured/codex-fast.js';
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import { PTYManager } from '../pty/manager.js';
import { parseSlash, resolveEffortArg, resolveModelArg, catalogModelChoices, validateEffort } from '../providers/slash-commands.js';
import { codexEffortsFor, codexDefaultEffortFor, CODEX_ALL_EFFORTS } from '../providers/codex-efforts.js';
import { autoArchivePatch, DEFAULT_AUTO_ARCHIVE_MS } from './auto-archive.js';
import { ThreadConfigStore, type ConfigPatch } from './thread-config.js';

type IStructuredManager = import('../structured/manager.js').IStructuredManager;

/** Build an Error carrying an HTTP `status` so a route can map it to a response code. */
export function transportError(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

/**
 * What ThreadSettings needs from the rest of the daemon. Every field is required: a build that
 * forgets one does not compile.
 */
export interface ThreadSettingsDeps {
  db: Database.Database;
  /** The one writer of a thread's config. */
  configStore: ThreadConfigStore;
  /** The CLI processes: a switch stops the process of the transport the thread leaves. */
  pty: Pick<PTYManager, 'isAlive' | 'kill' | 'on' | 'off'>;
  /** The accounts a thread type can run on. `undefined` when the daemon has no account store (a bare service). */
  accountDirectory: () => { has: (type: string, accountId: string) => boolean; defaultId: (type: string) => string } | undefined;
  /** A pick the harness refused late was taken back: the web loads the threads of the project again. */
  onTerminalChanged: (sessionId: string) => void;
  /** The thread operations that a settings change uses. SessionService gives its own methods. */
  threads: {
    structuredManagerFor(type: string): IStructuredManager | undefined;
    structuredManagerForTerminal(terminalId: string): IStructuredManager | undefined;
    isStructuredTerminal(terminal: terminalsDb.TerminalRow): boolean;
    /** Start the process of the thread again, on its new transport or account. */
    spawnTerminal(terminalId: string): void;
    /** Every key of the thread, the sticky one too. */
    revokeAllKeys(terminalId: string): void;
  };
}

/**
 * The settings of one thread (W3-B: moved out of SessionService): autonomy, the transport switch,
 * the account switch, the model and the effort, a pick that the harness refused, auto-archive and
 * alerts. Every write is a patch of the keys it changes, through ThreadConfigStore.
 */
export class ThreadSettings {
  constructor(private readonly deps: ThreadSettingsDeps) {}

  private readonly settingsLock = new Map<string, Promise<unknown>>();

  // The inputs under the names the moved code uses.
  private get db(): Database.Database { return this.deps.db; }
  private get configStore(): ThreadConfigStore { return this.deps.configStore; }
  private get ptyManager(): Pick<PTYManager, 'isAlive' | 'kill' | 'on' | 'off'> { return this.deps.pty; }
  private get accountDirectory() { return this.deps.accountDirectory(); }
  private onTerminalChanged(sessionId: string): void { this.deps.onTerminalChanged(sessionId); }
  private structuredManagerFor(type: string): IStructuredManager | undefined { return this.deps.threads.structuredManagerFor(type); }
  private structuredManagerForTerminal(terminalId: string): IStructuredManager | undefined { return this.deps.threads.structuredManagerForTerminal(terminalId); }
  private isStructuredTerminal(terminal: terminalsDb.TerminalRow): boolean { return this.deps.threads.isStructuredTerminal(terminal); }
  private spawnTerminal(terminalId: string): void { this.deps.threads.spawnTerminal(terminalId); }
  private revokeAllKeys(terminalId: string): void { this.deps.threads.revokeAllKeys(terminalId); }

  /**
   * Turn a thread's auto-archive policy on or off: a patch of its two keys.
   */
  setAutoArchive(terminalId: string, enabled: boolean, ms: number = DEFAULT_AUTO_ARCHIVE_MS): terminalsDb.Terminal | null {
    const row = terminalsDb.getById(this.db, terminalId);
    if (!row) return null;
    this.configStore.patch(terminalId, autoArchivePatch(enabled, ms));
    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  /**
   * Toggle per-thread push alerts (the bell): a patch of the one key.
   * Disable deletes the key so configs don't accumulate `alertsEnabled: false`.
   */
  setAlertsEnabled(terminalId: string, enabled: boolean): terminalsDb.Terminal | null {
    const row = terminalsDb.getById(this.db, terminalId);
    if (!row) return null;
    this.configStore.patch(terminalId, { alertsEnabled: enabled ? true : null });
    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  /**
   * Set a thread's autonomy (the per-agent dial). Persists `config.autonomy` onto
   * the terminal (merged into its config JSON so resume respects it) AND flips the
   * live escalation: 'autonomous' → auto-allow (resolves any currently-pending
   * request + future ones); 'supervised' → surface gated tools as Needs again.
   * Returns false when the terminal doesn't exist.
   */
  setAutonomy(terminalId: string, mode: 'supervised' | 'autonomous'): boolean {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return false;
    this.configStore.patch(terminalId, { autonomy: mode });
    this.structuredManagerFor(terminal.type)?.setEscalate(terminalId, mode !== 'autonomous');
    return true;
  }

  /**
   * Switch a running AI thread between the CLI (PTY) and Pretty (structured) transports
   * WITHOUT losing its conversation: kill the current process/connection, flip
   * `config.transport`, and re-spawn RESUMING the same `external_id` in the new transport
   * (structured backfills history from the transcript/ring; PTY resumes via
   * `claude --resume` / `codex resume`). The frontend swaps ChatView↔xterm off
   * `config.transport` on the next tabs reload.
   *
   * Guards (each throws an Error carrying an HTTP `status` for the route):
   *   - the thread must be a claude-code|codex thread (409);
   *   - it must have an `external_id` — a brand-new thread has nothing to resume (409);
   *   - Pretty must be available for the harness (codex has none until Phase B) (409);
   *   - it must be idle: a busy structured thread is interrupted then switched at the
   *     turn boundary (the preferred path); a busy PTY thread (no interruptible turn) is
   *     rejected so an in-flight turn isn't lost (409).
   * A no-op (returns the row unchanged) when the thread is already in the target transport.
   */
  async switchTransport(terminalId: string, target: 'structured' | 'pty', opts?: { force?: boolean }): Promise<terminalsDb.Terminal> {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) throw transportError(404, 'Terminal not found');
    if (terminal.type !== 'claude-code' && terminal.type !== 'codex') {
      throw transportError(409, 'Transport switching is only supported for Claude Code and Codex threads');
    }
    if (!terminal.external_id) {
      throw transportError(409, 'This thread has no session yet — send a message first, then switch');
    }
    if (target === 'structured' && !this.structuredManagerFor(terminal.type)) {
      throw transportError(409, 'Pretty transport is not available for this harness yet');
    }

    let config: Record<string, any> = {};
    try { config = JSON.parse(terminal.config || '{}'); } catch { /* default {} */ }
    // A coordinator's persona + enforcement membrane live only in the structured (Pretty)
    // transport; the PTY path runs ungoverned. Refuse to switch a coordinator to PTY (reject
    // BEFORE any teardown, so the thread is left intact) — see spawnTerminal's fail-closed guard.
    if (target === 'pty' && config.role === 'coordinator') {
      throw transportError(409, 'A coordinator must stay on Pretty transport — it cannot run as a PTY thread');
    }
    const current: 'structured' | 'pty' = config.transport === 'structured' ? 'structured' : 'pty';
    if (current === target) return terminalsDb.rowToTerminal(terminal); // already there — idempotent

    // Idle guard. Interrupt-then-switch a busy structured turn (preferred); reject a busy
    // PTY thread, whose in-flight turn we can't cleanly interrupt without losing work.
    if (terminal.status === 'working') {
      const live = this.structuredManagerForTerminal(terminalId);
      if (live?.isAlive(terminalId)) {
        await this.settleStructuredTurn(live, terminalId);
      } else if (!opts?.force) {
        throw transportError(409, 'This thread is busy — wait for the current turn to finish, then switch');
      }
      // force (2026-11-06): the user confirmed it — the CLI process is stopped below mid-turn and the
      // conversation resumes in the other transport from what the CLI had saved.
    }

    // Fully tear down the OLD transport (awaiting its exit) BEFORE re-spawning, so its async
    // exit handler can't null the pid / reset the status of the transport we're about to start.
    await this.killCurrentTransport(terminal.type, terminalId, current);
    // Only now end the keys (the Codex Pretty sticky key too; the next spawn mints a fresh one).
    // Revoking first made the old CLI's last status call fail with 401 while it shut down.
    this.revokeAllKeys(terminalId);

    // Only `transport` is written: the config read at the top is older than the awaits above
    // (a turn outcome, a model pick), so it is never written back.
    this.configStore.patch(terminalId, { transport: target === 'structured' ? 'structured' : null });
    terminalsDb.updatePid(this.db, terminalId, null);

    // Re-spawn: spawnTerminal reads the freshly-merged config and dispatches to the right
    // transport, resuming `external_id` (structured `-r`/backfill or PTY resume) either way.
    this.spawnTerminal(terminalId);

    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  /**
   * Move a Claude Code or Codex thread to another account (2026-11-06): pin `config.accountId`
   * and, when the thread is running, restart it so the new login's env applies. The spawn env is
   * the only place an account acts, so a stopped or queued thread just takes the new pin.
   * A Codex login's sessions live in its own folder, so a Codex thread that changes account
   * cannot resume its session: its resume handle is dropped and the next spawn starts fresh
   * (the Dispatch history stays). A Codex Pretty thread runs on the shared app-server, which
   * has one login, so it may only run as `cli`.
   */
  async switchAccount(terminalId: string, accountId: string, opts?: { force?: boolean }): Promise<terminalsDb.Terminal> {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) throw transportError(404, 'Terminal not found');
    if (terminal.type !== 'claude-code' && terminal.type !== 'codex') {
      throw transportError(409, 'Only a Claude Code or Codex thread runs on an account');
    }
    if (typeof accountId !== 'string' || !accountId) throw transportError(400, 'accountId is required');
    if (this.accountDirectory && !this.accountDirectory.has(terminal.type, accountId)) throw transportError(404, 'Unknown account');

    let config: Record<string, any> = {};
    try { config = JSON.parse(terminal.config || '{}'); } catch { /* default {} */ }
    const current: 'structured' | 'pty' = config.transport === 'structured' ? 'structured' : 'pty';
    if (terminal.type === 'codex' && current === 'structured' && accountId !== 'cli') {
      throw transportError(409, 'A Codex Pretty thread runs on the CLI login only. Switch it to CLI mode first.');
    }
    if (config.accountId === accountId) return terminalsDb.rowToTerminal(terminal); // already there — idempotent
    const previous: string = typeof config.accountId === 'string' ? config.accountId : this.accountDirectory?.defaultId(terminal.type) ?? 'cli';

    const alive = current === 'pty' ? this.ptyManager.isAlive(terminalId) : !!this.structuredManagerFor(terminal.type)?.isAlive(terminalId);
    if (alive && terminal.status === 'working') {
      const live = this.structuredManagerForTerminal(terminalId);
      if (live?.isAlive(terminalId)) await this.settleStructuredTurn(live, terminalId);
      else if (!opts?.force) throw transportError(409, 'This thread is busy — wait for the current turn to finish, then switch');
    }
    if (alive) {
      await this.killCurrentTransport(terminal.type, terminalId, current);
      this.revokeAllKeys(terminalId);
    }

    // Only `accountId` is written (the config read at the top is older than the awaits above).
    this.configStore.patch(terminalId, { accountId });
    if (terminal.type === 'codex' && previous !== accountId && terminal.external_id) terminalsDb.updateExternalId(this.db, terminalId, null);

    if (alive) {
      terminalsDb.updatePid(this.db, terminalId, null);
      this.spawnTerminal(terminalId);
    }
    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  /**
   * The model a thread runs NOW, for the Pretty header: what the live harness last reported
   * (IStructuredManager.getModel — init, a lead assistant frame, a switch), else the saved
   * `config.model` (what the next spawn passes), else undefined (the CLI's own default).
   */
  activeModel(terminalId: string): string | undefined {
    const row = terminalsDb.getById(this.db, terminalId);
    if (!row) return undefined;
    const manager = this.structuredManagerFor(row.type);
    const live = manager?.isAlive(terminalId) ? manager.getModel?.(terminalId) : undefined;
    if (live) return live;
    let config: Record<string, any> = {};
    try { config = JSON.parse(row.config || '{}'); } catch { /* default {} */ }
    return typeof config.model === 'string' && config.model ? config.model : undefined;
  }

  /**
   * The harness refused a saved pick when it was first used (Codex turn/start): take it out of the thread's config, but only
   * if the config still holds that very value (a newer pick has replaced it otherwise). The thread already shows the refusal.
   */
  undoRefusedPick(terminalId: string, info: { model?: string; effort?: string; restoredModel?: string }): void {
    const row = terminalsDb.getById(this.db, terminalId);
    if (!row) return;
    let changed = false;
    try {
      // The compare and the write are one unit: a newer pick that lands first is seen and kept.
      this.configStore.patch(terminalId, (cfg) => {
        const undo: ConfigPatch = {};
        if (info.effort && cfg.effort === info.effort) { undo.effort = null; undo.effortSetAt = null; changed = true; }
        if (info.model && cfg.model === info.model) {
          undo.model = info.restoredModel ? info.restoredModel : null;
          undo.modelSetAt = null;
          changed = true;
        }
        return changed ? undo : null;
      });
    } catch { return; }
    if (!changed) return;
    this.onTerminalChanged?.(row.session_id);
  }

  /** One thread's model and effort changes run one at a time: the second is judged against what the first left. */
  private withSettingsLock<T>(terminalId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.settingsLock.get(terminalId) ?? Promise.resolve();
    const next = prior.then(fn);
    const tail = next.then(() => undefined, () => undefined);
    this.settingsLock.set(terminalId, tail);
    void tail.then(() => { if (this.settingsLock.get(terminalId) === tail) this.settingsLock.delete(terminalId); });
    return next;
  }

  /** The efforts each Codex model takes according to the running app-server, or null when none is running. */
  async codexModelEfforts(): Promise<Record<string, string[]> | null> {
    return (await this.structuredManagerFor('codex')?.loadModelEfforts?.().catch(() => null)) ?? null;
  }

  /** The effort each Codex model runs at by default, as the app-server reports it (call after codexModelEfforts), or null. */
  codexModelDefaults(): Record<string, string> | null {
    return this.structuredManagerFor('codex')?.modelDefaultEfforts?.() ?? null;
  }

  /** The efforts a Codex model takes: the app-server's own list when it has answered, else the table. */
  private codexEffortsFor(model: string | null | undefined): readonly string[] {
    return codexEffortsFor(model, this.structuredManagerFor('codex')?.modelEfforts?.() ?? null);
  }

  /** The saved Codex effort, if the thread's model still takes it. */
  codexEffortFor(config: Record<string, any>, model?: string): string | undefined {
    const e = config.effort;
    // No pick: a hosted Sol thread runs at low, as Ask does (structured/codex-fast.ts); every other thread at the model's default.
    if (typeof e !== 'string') {
      const m0 = typeof (model ?? config.model) === 'string' ? (model ?? config.model) as string : undefined;
      const d = codexDefaultEffort(m0);
      // Only an effort the model takes: a wrong value in the environment must not fail every first turn.
      return d && m0 && this.codexEffortsFor(m0).includes(d) ? d : undefined;
    }
    const m = model ?? config.model;
    // No model known yet (the thread runs the app-server's default): the effort was checked against the model the thread
    // ran when it was picked, so keep it; if the default model does not take it, Codex refuses it on the first turn and the
    // refusal puts it back (CodexStructuredSessionManager.dropRefusedPick).
    if (typeof m !== 'string' || !m) return CODEX_ALL_EFFORTS.includes(e) ? e : undefined;
    return this.codexEffortsFor(m).includes(e) ? e : undefined;
  }

  /**
   * The checks the model and the effort change share: the thread exists and is a Claude, Codex, Grok or OpenCode thread; an
   * agent runs on its policy (an OVERSEER may change freely: an explicit `config.model` wins over the coordinator tier);
   * it is not mid-turn; and it is not a live CLI thread (its model belongs to the CLI's own /model).
   */
  private settingsTarget(terminalId: string, what: 'model' | 'effort') {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) throw transportError(404, 'Terminal not found');
    if (!['claude-code', 'codex', 'grok', 'opencode'].includes(terminal.type)) throw transportError(409, `This thread has no ${what} to switch`);
    let config: Record<string, any> = {};
    try { config = JSON.parse(terminal.config || '{}'); } catch { /* default {} */ }
    if (config.agentType || (config.role && config.role !== 'coordinator')) throw transportError(409, 'An agent thread runs on its policy model');
    // A turn parked on a question (needs_input) is still a turn: the question is answered inside it, so the change waits like the chip does.
    if (terminal.status === 'working') throw transportError(409, `This thread is busy — change the ${what} when the turn ends`);
    if (terminal.status === 'needs_input') throw transportError(409, `This thread is busy, waiting for your answer — change the ${what} when the turn ends`);
    const structured = config.transport === 'structured' || terminal.type === 'grok' || terminal.type === 'opencode';
    if (!structured && this.ptyManager.isAlive(terminalId)) throw transportError(409, `This thread runs in the CLI — use /${what} there`);
    return { terminal, config, structured, manager: this.structuredManagerFor(terminal.type) };
  }

  /** A change the harness refused: say so in the thread (visible on every Pretty surface), then fail with its words. */
  private refuse(manager: import('../structured/manager.js').IStructuredManager | undefined, terminalId: string, what: string, error: string): never {
    try { manager?.postNotice?.(terminalId, `Could not change the ${what}: ${error}`); } catch { /* a notice is best effort */ }
    throw transportError(400, error);
  }

  /**
   * The Pretty model switcher: run `model` from the thread's next turn, keeping the conversation.
   *
   * A live Pretty thread switches in place by its harness's own mechanism (IStructuredManager.setModel:
   * Claude `set_model`, Codex `turn/start model`, ACP `session/set_model` / `set_config_option`); a
   * stopped one only saves the pick, which its next start passes. Either way the pick is saved to
   * `config.model` with `config.modelSetAt`, so a relaunch (daemon restart, Pretty -> CLI) keeps it
   * even before a turn has run on it (see thread-settings.ts).
   *
   * Refused (409) while a turn runs — a switch mid-turn would change the model under a running
   * tool loop, and Codex would only apply it to the NEXT turn anyway, so the switcher is disabled
   * then — and for a live CLI thread, whose model belongs to the CLI (`/model`). A harness that
   * refuses the model fails with 400 and its own message (also posted as a line in the thread); the saved
   * model is left alone. A thread that stops before the harness answers is not a refusal: the pick is saved
   * and the next start uses it.
   *
   * Codex (slash menu): the new model must say which effort it runs at. A thread keeps the effort of its last
   * turn when the model changes (live-checked on codex-cli 0.166), so a saved effort the new model does not take,
   * or none saved, becomes the new model's own default (`effortNow`, with `clearedEffort` for a dropped one).
   */
  setThreadModel(
    terminalId: string,
    model: string,
  ): Promise<{ model: string; terminal: terminalsDb.Terminal; clearedEffort?: string; effortNow?: string }> {
    return this.withSettingsLock(terminalId, () => this.setThreadModelLocked(terminalId, model));
  }

  private async setThreadModelLocked(
    terminalId: string,
    model: string,
  ): Promise<{ model: string; terminal: terminalsDb.Terminal; clearedEffort?: string; effortNow?: string }> {
    if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/\[\]~-]{0,120}$/.test(model)) throw transportError(400, 'model is not a valid model id');
    // Codex: which efforts the new model takes (the app-server's list, else the table), and what it runs at by default.
    // The first check is an early, cheap refusal (busy, CLI, agent). Asking the app-server can take a while and the thread can
    // start a turn or move to the CLI meanwhile, so the checks run again once the answer is in, and everything after uses the
    // settings as they are THEN.
    const first = this.settingsTarget(terminalId, 'model');
    if (first.terminal.type === 'codex') await first.manager?.loadModelEfforts?.().catch(() => null);
    const { terminal, config, structured, manager } = this.settingsTarget(terminalId, 'model');

    let effortNow: string | undefined;
    let clearedEffort: string | undefined;
    if (terminal.type === 'codex') {
      const was = this.activeModel(terminalId);
      const kept = typeof config.effort === 'string' && this.codexEffortsFor(model).includes(config.effort);
      if (!kept && model !== was) {
        if (typeof config.effort === 'string') clearedEffort = config.effort;
        effortNow = codexDefaultEffortFor(model, manager?.modelDefaultEfforts?.() ?? null);
      }
    }

    let resolved = model;
    let replaced = false;
    if (structured && manager?.isAlive(terminalId) && manager.setModel) {
      const exit = this.watchExit(manager, terminalId);
      try {
        resolved = await manager.setModel(terminalId, model);
        if (effortNow) await manager.setEffort?.(terminalId, effortNow);
        // The old process answered "ok" but may have ended, and been replaced, before this code resumed: the replacement runs
        // whatever it was started with, so it counts as replaced exactly like a rejected request does.
        if (exit.happened()) replaced = true;
      } catch (e) {
        // The thread ended before it answered (even if a new process already took its place): nothing was refused, so the
        // pick is kept and the next start uses it. A refusal is an answer from a process that is still the same one.
        if (exit.happened()) replaced = true;
        else if (manager.isAlive(terminalId)) this.refuse(manager, terminalId, 'model', (e as Error)?.message || 'The harness refused the model');
      } finally { exit.off(); }
    }
    // The new model's default effort is sent so the thread is not left on the old model's level, but it is not the owner's
    // pick: it is not saved (a resume runs at the model default anyway). A saved effort the model cannot take is dropped.
    this.configStore.patch(terminalId, { model, modelSetAt: Date.now(), ...(clearedEffort ? { effort: null, effortSetAt: null } : {}) });
    // A replacement process may already be running, started from the config as it was before this pick: it runs the old value
    // and nothing else would tell it. Apply the saved pick to it now (and take the save back if it refuses).
    if (replaced && manager?.isAlive(terminalId) && manager.setModel) {
      const target = manager;
      await this.reapplyToReplacement(manager, terminalId, 'model', async () => {
        resolved = await target.setModel!(terminalId, model);
        if (effortNow) await target.setEffort?.(terminalId, effortNow);
      }, { model: config.model, modelSetAt: config.modelSetAt, effort: config.effort, effortSetAt: config.effortSetAt });
    }
    return {
      model: resolved, terminal: terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!),
      ...(clearedEffort ? { clearedEffort } : {}), ...(effortNow ? { effortNow } : {}),
    };
  }

  /** Did this thread's process exit while a change was being sent? Counts an exit followed by a new spawn (a replacement is alive again). */
  private watchExit(manager: import('../structured/manager.js').IStructuredManager, terminalId: string): { happened: () => boolean; off: () => void } {
    let exited = false;
    const on = (id: string) => { if (id === terminalId) exited = true; };
    manager.on('exit', on);
    return { happened: () => exited, off: () => { manager.off('exit', on); } };
  }

  /**
   * The Pretty effort picker: run `effort` from the thread's next turn. Claude and Codex only in this phase (Grok and
   * OpenCode have no effort control wired: 409). Per thread: it is not saved as a default for new threads. A Codex effort
   * is checked against the model the thread runs, because the efforts differ by model (model/list, else the built-in
   * table). Same guards as the model switch (mid-turn 409, live CLI thread 409, an overseer may change). The pick is saved
   * with `config.effortSetAt` after the harness took it, so a relaunch keeps it (thread-settings.ts); a refusal is posted
   * in the thread; a thread that stops before it answers keeps the pick for its next start.
   */
  setThreadEffort(terminalId: string, effort: string): Promise<{ effort: string; terminal: terminalsDb.Terminal }> {
    return this.withSettingsLock(terminalId, () => this.setThreadEffortLocked(terminalId, effort));
  }

  private async setThreadEffortLocked(terminalId: string, effort: string): Promise<{ effort: string; terminal: terminalsDb.Terminal }> {
    this.settingsTarget(terminalId, 'effort'); // an early, cheap refusal (busy, CLI, agent) before any waiting
    // Asking the Codex app-server can take a while; a turn can start or the thread can move to the CLI meanwhile,
    // so the checks run again once the answer is in.
    const first = this.settingsTarget(terminalId, 'effort');
    if (first.terminal.type === 'codex') await first.manager?.loadModelEfforts?.().catch(() => null);
    const { terminal, config, structured, manager } = this.settingsTarget(terminalId, 'effort');
    let codexEfforts: readonly string[] | undefined;
    let codexModel: string | undefined;
    if (terminal.type === 'codex') {
      codexModel = this.activeModel(terminalId) ?? (typeof config.model === 'string' ? config.model : undefined);
      codexEfforts = this.codexEffortsFor(codexModel);
    }
    const bad = validateEffort(terminal.type, effort, { codexEfforts, codexModel });
    if (bad) throw transportError(terminal.type === 'claude-code' || terminal.type === 'codex' ? 400 : 409, bad);
    let replaced = false;
    if (structured && manager?.isAlive(terminalId)) {
      if (!manager.setEffort) throw transportError(409, 'Not yet available for this agent.');
      const exit = this.watchExit(manager, terminalId);
      try {
        await manager.setEffort(terminalId, effort);
        if (exit.happened()) replaced = true; // see setThreadModelLocked: a success from a process that was replaced meanwhile
      } catch (e) {
        if (exit.happened()) replaced = true;
        else if (manager.isAlive(terminalId)) this.refuse(manager, terminalId, 'effort', (e as Error)?.message || 'The harness refused the effort');
      } finally { exit.off(); }
    }
    this.configStore.patch(terminalId, { effort, effortSetAt: Date.now() });
    // A replacement started from the config before this pick runs the old effort: apply the saved pick to it (see setThreadModelLocked).
    if (replaced && manager?.isAlive(terminalId) && manager.setEffort) {
      const target = manager;
      await this.reapplyToReplacement(manager, terminalId, 'effort', () => target.setEffort!(terminalId, effort), { effort: config.effort, effortSetAt: config.effortSetAt });
    }
    return { effort, terminal: terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!) };
  }

  /**
   * The process that was asked died and a replacement is running: apply the (already saved) pick to the replacement. If the
   * replacement refuses it, that IS a refusal: the save is taken back, the thread says so. If it ends too, the pick stays
   * saved for the start after it.
   */
  private async reapplyToReplacement(
    manager: import('../structured/manager.js').IStructuredManager,
    terminalId: string,
    what: 'model' | 'effort',
    apply: () => Promise<unknown>,
    restore: ConfigPatch,
  ): Promise<void> {
    const exit = this.watchExit(manager, terminalId);
    try {
      await apply();
    } catch (e) {
      if (exit.happened() || !manager.isAlive(terminalId)) return;
      // The values from before the pick; one that was absent then is `undefined` here, which removes the key again.
      this.configStore.patch(terminalId, restore);
      this.refuse(manager, terminalId, what, (e as Error)?.message || `The harness refused the ${what}`);
    } finally { exit.off(); }
  }

  /**
   * A typed `/model x` or `/effort x` in a Pretty Claude thread, sent by the owner. Claude would run it
   * itself, but Dispatch's own control request then masks the CLI's version (spike 2026-11-06: the CLI says
   * "set" and the model does not change), so Dispatch runs it. Returns null for anything else, which then
   * goes to the agent as a normal message: other text, the leading-space escape, a coordinator's message, a
   * Codex or CLI thread. Throws a 400 with a plain reason for a bare command or a bad value, so the text
   * never reaches the model by mistake; mid-turn it fails 409 like the chip (the text stays in the box).
   */
  async handleTypedSlash(
    terminalId: string,
    content: unknown,
    source: import('../structured/manager.js').MessageSource | undefined,
  ): Promise<terminalsDb.Terminal | null> {
    if (source !== 'user' || typeof content !== 'string') return null;
    const slash = parseSlash(content);
    if (!slash?.known || (slash.name !== 'model' && slash.name !== 'effort')) return null;
    const row = terminalsDb.getById(this.db, terminalId);
    if (!row || row.type !== 'claude-code' || !this.isStructuredTerminal(row)) return null;
    if (!slash.args) throw transportError(400, `Pick a ${slash.name} with the picker, or type /${slash.name} followed by a value.`);
    if (slash.name === 'model') {
      const parsed = resolveModelArg(catalogModelChoices('claude-code'), slash.args);
      if ('error' in parsed) throw transportError(400, parsed.error);
      return (await this.setThreadModel(terminalId, parsed.model)).terminal;
    }
    const parsed = resolveEffortArg('claude-code', slash.args);
    if ('error' in parsed) throw transportError(400, parsed.error);
    return (await this.setThreadEffort(terminalId, parsed.effort)).terminal;
  }

  /**
   * Interrupt a live structured turn and wait for the turn boundary ('idle', 'needs-help',
   * 'scheduled') or the process exit — bounded, so a wedged CLI can't hang the switch
   * forever. A turn that ends by asking a question or ending on a wake-scheduler tool
   * satisfies neither 'idle' nor 'exit', so without these two the switch burned the full
   * timeout on every question-ending turn (found by the Task 2 review).
   */
  private async settleStructuredTurn(
    manager: import('../structured/manager.js').IStructuredManager,
    terminalId: string,
    timeoutMs = 5000,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        manager.off('idle', onSettle);
        manager.off('exit', onSettle);
        manager.off('needs-help', onSettle);
        manager.off('scheduled', onSettle);
        resolve();
      };
      const onSettle = (id: string) => { if (id === terminalId) finish(); };
      manager.on('idle', onSettle);
      manager.on('needs-help', onSettle);
      manager.on('scheduled', onSettle);
      manager.on('exit', onSettle);
      manager.interrupt(terminalId);
      timer = setTimeout(finish, timeoutMs);
    });
  }

  /**
   * Kill whichever transport currently backs a thread and wait for it to fully exit
   * (bounded), mirroring restartTerminal's await-exit-before-respawn discipline.
   */
  async killCurrentTransport(type: string, terminalId: string, current: 'structured' | 'pty'): Promise<void> {
    if (current === 'pty') {
      if (!this.ptyManager.isAlive(terminalId)) { this.ptyManager.kill(terminalId); return; }
      await this.awaitExit((cb) => this.ptyManager.on('exit', cb), (cb) => this.ptyManager.off('exit', cb), () => this.ptyManager.kill(terminalId), terminalId);
    } else {
      const manager = this.structuredManagerFor(type);
      if (!manager?.isAlive(terminalId)) { manager?.kill(terminalId); return; }
      await this.awaitExit((cb) => manager.on('exit', cb), (cb) => manager.off('exit', cb), () => manager.kill(terminalId), terminalId);
    }
  }

  /** Shared kill-then-await-'exit'(terminalId) helper, bounded so a stuck process can't hang. */
  private async awaitExit(
    on: (cb: (id: string) => void) => void,
    off: (cb: (id: string) => void) => void,
    kill: () => void,
    terminalId: string,
    timeoutMs = 3000,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => { if (done) return; done = true; if (timer) clearTimeout(timer); off(onExit); resolve(); };
      const onExit = (id: string) => { if (id === terminalId) finish(); };
      on(onExit);
      kill();
      timer = setTimeout(finish, timeoutMs);
    });
  }
}
