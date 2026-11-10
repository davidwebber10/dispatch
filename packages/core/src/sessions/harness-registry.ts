import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import * as messageSourceDb from '../db/message-source.js';
import { getProvider } from '../providers/registry.js';
import { findNewestUnresolvedUserUuid } from './cc-sessions.js';
import { resolveTranscriptPath } from './transcript-path.js';
import type { ThreadConfigStore } from './thread-config.js';
import type { SessionWiring } from './session-wiring.js';

type IStructuredManager = import('../structured/manager.js').IStructuredManager;

/** What HarnessRegistry needs. Every field is required. */
export interface HarnessRegistryDeps {
  db: Database.Database;
  /** The one writer of a thread's config. */
  configStore: ThreadConfigStore;
  /** What the daemon handed over after the services were built (the keys, the usage limits). Read at each event. */
  wiring: SessionWiring;
  /** The thread operations that the manager events use. SessionService gives its own methods. */
  threads: {
    /** A model or effort the harness refused late goes back (ThreadSettings.undoRefusedPick). */
    undoRefusedPick(terminalId: string, info: { model?: string; effort?: string; restoredModel?: string }): void;
  };
}

/**
 * The structured manager of each harness, and what the daemon does with their events (W3-B: moved
 * out of SessionService): the session id of a thread, a restarted process, a usage limit, a turn
 * end, a refused model or effort, a lost Claude conversation, the source of a Claude message, and
 * the key of a process that exits.
 */
export class HarnessRegistry {
  constructor(private readonly deps: HarnessRegistryDeps) {}

  // The inputs under the names the moved code uses.
  private get db(): Database.Database { return this.deps.db; }
  private get configStore(): ThreadConfigStore { return this.deps.configStore; }
  private get wiring(): SessionWiring { return this.deps.wiring; }
  private undoRefusedPick(terminalId: string, info: { model?: string; effort?: string; restoredModel?: string }): void { this.deps.threads.undoRefusedPick(terminalId, info); }

  /** The key registry came after some managers: their exits revoke keys from now on. */
  revokeKeysOnExitForAll(): void {
    for (const manager of this.structuredManagers.values()) this.revokeKeysOnExit(manager);
  }

  private structuredManagers = new Map<string, IStructuredManager>();

  private keyedManagers = new WeakSet<object>();
  private revokeKeysOnExit(manager: IStructuredManager): void {
    if (this.keyedManagers.has(manager)) return;
    this.keyedManagers.add(manager);
    manager.on('exit', (terminalId: string) => this.wiring.threadKeys?.onStructuredExit(terminalId));
  }

  registerStructuredManager(type: string, manager: IStructuredManager): void {
    getProvider(type); // reject an unregistered harness instead of silently accepting it
    const existing = this.structuredManagers.get(type);
    if (existing && existing !== manager) throw new Error(`Structured manager already registered: ${type}`);
    if (existing) return;
    this.structuredManagers.set(type, manager);
    if (this.wiring.threadKeys) this.revokeKeysOnExit(manager);
    this.persistStructuredSessionIds(manager, type);
    // A shared harness process (Codex app-server) that restarts gets a new pid; keep the stored one current.
    manager.on('process-restarted', (terminalId: string, pid: number) => {
      try { if (pid > 0 && terminalsDb.getById(this.db, terminalId)) terminalsDb.updatePid(this.db, terminalId, pid); } catch { /* best effort */ }
    });
    manager.on('usage-limit', (terminalId: string, limit: import('../limits/detect.js').UsageLimit) => {
      try { this.wiring.usageLimits?.park(terminalId, type, limit); } catch (err) { console.warn('[usage-limit] park failed:', err); }
    });
    for (const edge of ['idle', 'needs-help', 'failed']) manager.on(edge, (terminalId: string) => this.wiring.usageLimits?.onTurnEnded(terminalId));
    // A model or effort the harness refused LATE (Codex: on the turn that first carries it): the saved pick goes back.
    manager.on('settings-refused', (terminalId: string, info: { model?: string; effort?: string; restoredModel?: string }) => this.undoRefusedPick(terminalId, info));
    if (type === 'claude-code') {
      this.persistMessageSources(manager);
      this.forgetLostConversations(manager);
    }
  }

  /**
   * #76: Claude reported that it no longer has the conversation behind `-r <id>` (its
   * transcript was cleaned up). Every revive used to run the same doomed resume again. Clear
   * the stored id, so the next revive starts a fresh conversation, and keep the old id in
   * config for the record. Only when the stored id is still the lost one: a newer
   * conversation may have replaced it.
   */
  private forgetLostConversations(m: IStructuredManager): void {
    m.on('conversation-lost', (terminalId: string, lostId: string) => {
      try {
        const t = terminalsDb.getById(this.db, terminalId);
        if (!t || t.external_id !== lostId) return;
        this.configStore.patch(terminalId, { lostConversation: { externalId: lostId, at: new Date().toISOString() } });
        terminalsDb.updateExternalId(this.db, terminalId, null);
        console.warn(`[structured] thread ${terminalId}: conversation ${lostId} is gone; the next message starts a new one`);
      } catch { /* best effort — the worst case is the old retry */ }
    });
  }

  private persistMessageSources(m: IStructuredManager): void {
    // Durable source persistence: the manager emits this once a tagged turn's `result`
    // lands (its transcript lines are guaranteed flushed by then — see manager.ts's
    // `result` handler). Resolve it to the newest not-yet-recorded real user-text uuid in
    // this terminal's transcript and persist the pair, so a later disk-hydrated chat (after
    // the CLI process has exited) can still show the "via Dispatch" badge (see
    // readSessionBackfill's caller below and getConversation, both of which merge this back in).
    m.on('message-source', (terminalId: string, source: messageSourceDb.MessageSource) => {
      try {
        const t = terminalsDb.getById(this.db, terminalId);
        if (!t) return;
        const session = sessionsDb.getById(this.db, t.session_id);
        const workDir = t.working_dir || session?.working_dir;
        const sessionId = t.external_id;
        if (!workDir || !sessionId) return;
        const exclude = messageSourceDb.listUuids(this.db, terminalId);
        const uuid = findNewestUnresolvedUserUuid(workDir, sessionId, exclude);
        if (uuid) messageSourceDb.record(this.db, terminalId, uuid, source);
      } catch { /* best effort — a missed tag just degrades to a plain bubble, never an error */ }
    });
  }

  /**
   * Persist a structured manager's session id (surfaced from its init/session event) onto
   * the terminal's external_id, mirroring how the PTY path captures session ids. This is
   * what lets us resume the SAME conversation after a daemon restart. First-write-wins
   * for a HEALTHY identity — but a stored id whose transcript exists NOWHERE (captured
   * from a boot that never ran a turn) is a ghost: it can never be resumed or read, and
   * leaving it locked the terminal onto an empty history forever (the Dispatch
   * coordinator served 0 items and every resume referenced a nonexistent session). The
   * live process's self-reported id is authoritative over a ghost.
   *
   * The ghost check reads the CLAUDE transcript store, so for non-claude managers (Grok,
   * whose ids never resolve there) an existing external_id simply always wins — which is
   * right: a Grok id comes from session/new exactly once and never changes thereafter.
   */
  private persistStructuredSessionIds(m: IStructuredManager, type: string): void {
    m.on('session', (terminalId: string, sessionId: string) => {
      try {
        const t = terminalsDb.getById(this.db, terminalId);
        if (!t || t.type !== type || !sessionId || t.external_id === sessionId) return;
        if (t.external_id) {
          if (t.type !== 'claude-code') return;
          const session = sessionsDb.getById(this.db, t.session_id);
          const workDir = t.working_dir || session?.working_dir || '';
          if (resolveTranscriptPath(workDir, t.external_id)) return; // healthy — never clobber
        }
        terminalsDb.updateExternalId(this.db, terminalId, sessionId);
      } catch { /* best effort */ }
    });
  }

  /**
   * The structured manager for a terminal type, or undefined when that type has no
   * structured transport. Both managers satisfy IStructuredManager, so every structured
   * operation routes through this one accessor:
   *   claude-code → the Claude stream-json manager
   *   codex       → the Codex app-server manager (only when CODEX_PRETTY_ENABLED)
   *   grok        → the Grok ACP manager (only when GROK_PRETTY_ENABLED)
   */
  structuredManagerFor(type: string): IStructuredManager | undefined {
    return this.structuredManagers.get(type);
  }

  /** Resolve the structured manager for a terminal id (looks up its type first). Public so the
   *  structured-ws upgrade handler can pick the RIGHT manager (claude vs codex) per connection. */
  structuredManagerForTerminal(terminalId: string): IStructuredManager | undefined {
    const t = terminalsDb.getById(this.db, terminalId);
    return t ? this.structuredManagerFor(t.type) : undefined;
  }
}
