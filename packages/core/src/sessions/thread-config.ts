import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import type { StatusDeclaration } from '../structured/manager.js';

/**
 * A thread's config: the one JSON column `terminals.config` (engineering program W2-A).
 *
 * Every key that Dispatch reads or writes is named here. A key that is not named (a plugin's, a
 * newer daemon's) is kept as it is: the store never drops a key that it does not know.
 */
export interface TerminalConfig {
  // --- Spawn settings: what the next start of the thread passes to the harness ---
  /** The saved model (a tier alias or a full id). Group and price by the frame's model id, never by this. */
  model?: string;
  /** When the owner picked the model with the Pretty switcher (ms). Newer than the transcript wins. */
  modelSetAt?: number;
  effort?: string;
  effortSetAt?: number;
  /** 'structured' is Pretty; absent is the CLI (PTY). */
  transport?: 'structured';
  /** The account the thread is pinned to; absent means the harness default. */
  accountId?: string;
  skipPermissions?: boolean;
  /** 'supervised' shows gated tools as Needs; 'autonomous' allows them. */
  autonomy?: 'supervised' | 'autonomous';
  /** Approval setting of a chat thread (os/approvals.ts): auto, ask or smart. Absent: today's autonomy rule. */
  approvals?: 'auto' | 'ask' | 'smart';
  /** OpenCode: the model has no tool endpoint, so the thread runs chat-only. Pinned at first sight. */
  toolsDisabled?: boolean;
  /** The MCP servers the thread was last started with (informational). */
  toolsAvailable?: string[];
  /** A headless run (never resumed) and its prompt. */
  runner?: boolean;
  runnerPrompt?: string;
  /** Start as a fork of this harness session. */
  branchFrom?: string;
  /** A thread Dispatch started to sign in to a provider. */
  signIn?: string;

  // --- Coordinator links: who started the thread and what for ---
  role?: 'coordinator' | 'agent' | string;
  agentType?: string;
  mission?: string;
  /** The thread that started this one, and how deep the chain is (a root thread is 0). */
  spawnedBy?: string;
  spawnDepth?: number;
  origin?: string;
  /** A scheduled role run: its run id and what it may do. */
  roleRun?: string;
  roleAuthority?: string;
  /** The harness a coordinator gives its workers by default. */
  workerHarness?: string;
  /** A queued thread: parked, with its task, maybe until another thread ends. */
  queued?: boolean;
  queuedTask?: string;
  dependsOn?: string;

  // --- Thread state: written by the daemon as the thread runs ---
  lastOutcome?: {
    summary: string;
    needsHelp: boolean;
    inferred: boolean;
    declaredState?: 'done' | 'blocked';
    blocker?: string;
    at: string;
  };
  /** A report_status call of a CLI thread, kept until its Stop hook reads it. */
  pendingDeclaration?: StatusDeclaration;
  /** Boot kickstart: when the thread was last told to continue. */
  kickedAt?: string;
  /** Graceful shutdown: the turn was cut off by the daemon. Consumed at the next boot. */
  interruptedAt?: string;
  /** Why the thread is dormant ('scheduled' status). */
  scheduledWake?: string;
  /** Claude no longer has the conversation behind the stored session id. */
  lostConversation?: { externalId: string; at: string };
  totalTokens?: number;
  outputTokens?: number;
  /** Overseer recap bookkeeping (sessions/interim-recap.ts, overseer/ledger-service.ts). */
  interimDueAt?: string;
  lastRecapAt?: string;
  titlesAskedAt?: string;

  // --- UI state ---
  autoArchive?: boolean;
  autoArchiveMs?: number;
  alertsEnabled?: boolean;
  boardState?: { acknowledgedAt?: string; override?: string | null };
  /** A notes tab's document and a browser tab's address: the two keys a client may set. */
  html?: string;
  url?: string;
  /** A file tab's path. */
  path?: string;

  // --- Security ---
  /** The thread gets the Doppler token (only with the token scope `opted-in`). */
  secretsEnv?: boolean;
}

/** What `read` returns: the known keys typed, and every other key of the row kept. */
export type StoredConfig = TerminalConfig & Record<string, unknown>;

/** A change to named keys. `null` or `undefined` deletes the key. A key that is not named stays. */
export type ConfigPatch = { [K in keyof TerminalConfig]?: TerminalConfig[K] | null };

export type ConfigPatchFn = (current: Readonly<StoredConfig>) => ConfigPatch | null;

export interface ConfigTx {
  /** The config as it is now, with the patches of this transaction applied. */
  get(): StoredConfig;
  patch(p: ConfigPatch): void;
}

/**
 * The keys that the generic `PATCH /api/terminals/:id` may set from a client's config. They are
 * the content of the two tabs that have no process (notes, browser). Every other key has its own
 * route with its own checks (model, effort, transport, account, autonomy, auto-archive, alerts,
 * secrets-env), so a client config cannot change what a thread may do.
 */
export const CLIENT_SETTABLE_KEYS = ['html', 'url'] as const satisfies readonly (keyof TerminalConfig)[];

/** Split a client's config into the patch that is allowed and the names of the keys that are not. */
export function pickClientSettable(config: Record<string, unknown>): { patch: ConfigPatch; ignored: string[] } {
  const patch: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(config ?? {})) {
    if ((CLIENT_SETTABLE_KEYS as readonly string[]).includes(key)) patch[key] = value;
    else ignored.push(key);
  }
  return { patch: patch as ConfigPatch, ignored };
}

function applyPatch(target: Record<string, unknown>, patch: ConfigPatch): boolean {
  let changed = false;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null || value === undefined) {
      if (key in target) { delete target[key]; changed = true; }
    } else {
      // Always a change: a deep compare costs more than the write it would save.
      target[key] = value;
      changed = true;
    }
  }
  return changed;
}

/**
 * The one writer of `terminals.config`.
 *
 * The column used to be written whole from a copy that the caller read earlier, so two writers
 * each dropped the other's key. Here a write names only the keys it changes; the read, the merge
 * and the write run in one SQLite transaction (BEGIN IMMEDIATE), so a second writer, in this
 * process or in another, waits and then merges onto the first writer's result.
 *
 * Inside an open transaction of the same connection (StatusService.transition) a patch joins that
 * transaction and rolls back with it.
 */
export class ThreadConfigStore {
  private readonly warned = new Set<string>();

  constructor(private readonly db: Database.Database) {}

  /** A fresh copy of the config. Bad JSON, a value that is not an object, or no row: `{}`. */
  read(terminalId: string): StoredConfig {
    return this.parse(terminalId, terminalsDb.getById(this.db, terminalId)?.config);
  }

  /**
   * Change the named keys and return the config after the change. A function patch gets the
   * current config (read inside the transaction) and returns the change, or `null` for no write.
   * A thread that does not exist is not written.
   */
  patch(terminalId: string, patch: ConfigPatch | ConfigPatchFn): StoredConfig {
    return this.immediate(() => {
      const row = terminalsDb.getById(this.db, terminalId);
      const current = this.parse(terminalId, row?.config);
      if (!row) return current;
      const change = typeof patch === 'function' ? patch(current) : patch;
      if (!change) return current;
      // The function got `current`; merge onto a copy so a callback that kept it sees no change.
      const next: StoredConfig = { ...current };
      if (!applyPatch(next, change)) return current;
      terminalsDb.writeConfigRaw(this.db, terminalId, next);
      return next;
    });
  }

  /**
   * Several reads and patches of one thread's config as one unit, written once at the end.
   * If `fn` throws, nothing is written, and every other statement that `fn` ran on this
   * connection is rolled back too.
   */
  transaction<T>(terminalId: string, fn: (tx: ConfigTx) => T): T {
    return this.immediate(() => {
      const row = terminalsDb.getById(this.db, terminalId);
      let current = this.parse(terminalId, row?.config);
      let dirty = false;
      const out = fn({
        get: () => ({ ...current }),
        patch: (p) => {
          const next: StoredConfig = { ...current };
          if (applyPatch(next, p)) { current = next; dirty = true; }
        },
      });
      if (dirty && row) terminalsDb.writeConfigRaw(this.db, terminalId, current);
      return out;
    });
  }

  /** Write the whole config of a thread that was just created. Not for a thread that has run. */
  initialize(terminalId: string, config: TerminalConfig): void {
    terminalsDb.writeConfigRaw(this.db, terminalId, config as Record<string, unknown>);
  }

  private immediate<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  private parse(terminalId: string, text: string | null | undefined): StoredConfig {
    if (text === null || text === undefined || text === '') return {};
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as StoredConfig;
    } catch { /* reported below */ }
    if (!this.warned.has(terminalId)) {
      this.warned.add(terminalId);
      console.warn(`[thread-config] thread ${terminalId}: the saved config is not a JSON object; it reads as empty`);
    }
    return {};
  }
}
