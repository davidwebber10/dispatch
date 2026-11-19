import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import { subscribeHarnessEvents } from '../runtime/adapter.js';
import { listProviders } from '../providers/registry.js';
import { SessionService } from '../sessions/service.js';
import type { PtyLike } from './noop-pty.js';
import { ptyMessagePayload } from '../sessions/pty-message.js';
import type { StatusService } from '../status/service.js';
import type { KeyRegistry } from '../auth/principals.js';
import type { UsageLimitService } from '../limits/service.js';
import type { ThreadEvents } from '../plugins/thread-events.js';
import type { DeliverResult } from '../delivery/outbox.js';
import { ClaudeStructuredSessionManager, type IStructuredManager } from '../structured/manager.js';
import { CodexStructuredSessionManager } from '../structured/codex-manager.js';
import { AcpStructuredSessionManager } from '../structured/acp-manager.js';

type Setter<K extends keyof SessionService> = SessionService[K] extends (...args: infer A) => unknown ? A : never;

/**
 * Wire the structured-thread "membrane": when an escalating AGENT thread hits a
 * gated tool / AskUserQuestion the manager emits 'permission' (→ needs_input) and,
 * once answered, 'resolved' (→ working). Routing it through StatusService means it
 * broadcasts terminal:status + fires the same push/notify path the PTY/hook flow uses.
 */
function wirePermissionMembrane(manager: IStructuredManager, status: StatusService, sessions: SessionService, db: Database.Database, threadEvents: ThreadEvents): void {
  // Plugins observe every native frame (tool_use blocks) and every harness event (turns, usage).
  manager.on('event', (id: string, frame: unknown) => { try { threadEvents.onNativeFrame(id, frame); } catch { /* observers never block */ } });
  subscribeHarnessEvents(manager, id => db.open ? terminalsDb.getById(db, id)?.type : undefined, event => { try { threadEvents.onHarnessEvent(event); } catch { /* observers never block */ } status.accept(event, committed => {
    const id = committed.terminalId;
    if (committed.type === 'permission.requested') {
      if (sessions.routeAgentQuestionToCoordinator(id, { toolName: committed.toolName, questions: committed.questions })) status.markWorking(id, 'Asking Control Plane…');
    } else if (committed.type === 'turn.completed') {
      const detail = committed.detail;
      if (committed.outcome === 'idle') {
        const summary = 'summary' in detail ? detail.summary ?? '' : sessions.lastAssistantTextPublic(id);
        sessions.noteTurnOutcome(id, { summary, needsHelp: false, inferred: !detail.declared, state: detail.state, blocker: detail.blocker });
        sessions.noteAgentCompletion(id);
      } else if (committed.outcome === 'needs_help') {
        sessions.noteTurnOutcome(id, { summary: detail.summary ?? '', needsHelp: true, inferred: !!detail.inferred });
        sessions.noteAgentNeedsHelp(id, detail.ask ?? 'Needs your input');
      }
    }
  }); });
}

export interface HarnessInputs {
  db: Database.Database;
  sessionService: SessionService;
  statusService: StatusService;
  threadEvents: ThreadEvents;
  env: NodeJS.ProcessEnv;
  /**
   * Structured managers by provider name, in place of the real Claude, Codex, Grok and opencode
   * managers (test seam: no CLI runs). Must include `claude-code`.
   */
  injected?: Partial<Record<string, IStructuredManager>>;
}

export interface HarnessServices {
  /** Every structured manager, by provider name. */
  managers: Map<string, IStructuredManager>;
  /** The Claude manager: also the fallback of the structured socket. */
  claude: IStructuredManager;
  /** Every manager but Claude's. */
  extra: Map<string, IStructuredManager>;
}

/** Every harness receives identical registration, lifecycle and accounting wiring. A build with no Claude manager throws. */
export function wireHarnesses(i: HarnessInputs): HarnessServices {
  const managers = new Map<string, IStructuredManager>();
  const add = (name: string, manager: IStructuredManager) => {
    i.sessionService.registerStructuredManager(name, manager);
    wirePermissionMembrane(manager, i.statusService, i.sessionService, i.db, i.threadEvents);
    managers.set(name, manager);
  };
  if (i.injected) {
    // Test seam: the caller's managers stand in for the real CLI managers, so no CLI runs.
    for (const [name, manager] of Object.entries(i.injected)) if (manager) add(name, manager);
  } else {
    for (const provider of listProviders()) {
      if (provider.structured.disabledBy && i.env[provider.structured.disabledBy] === '0') continue;
      add(provider.name, provider.structured.protocol === 'claude-json' ? new ClaudeStructuredSessionManager()
        : provider.structured.protocol === 'acp' ? new AcpStructuredSessionManager(provider.structured.dialect)
        : new CodexStructuredSessionManager());
    }
  }
  const claude = managers.get('claude-code');
  if (!claude) throw new Error('buildDaemon: no structured manager for "claude-code". A "managers" map must include claude-code.');
  return { managers, claude, extra: new Map([...managers].filter(([name]) => name !== 'claude-code')) };
}

/**
 * Builds the deliver function for a watch wake (the delivery outbox calls it for a `watch` row):
 * picks transport per target the SAME way spawnTerminal/ensureStructuredAlive already do —
 * `config.transport === 'structured'` AND a structured manager exists for that harness.
 * Structured threads get `ensureStructuredAlive` (lazily resumes a dead one) +
 * `sendStructuredMessage`; everything else (PTY threads — claude-code/codex still on the CLI
 * transport) gets the wake typed in and submitted (`ptyMessagePayload`), exactly as
 * `sendThreadMessage` delivers a peer message to a CLI thread.
 *
 * The answer tells the outbox what to do with the row (W2-C). `gone`: the watcher vanished or is
 * a shell tab; the wake is dropped. `not-alive`: nothing can take the wake now (a CLI thread with
 * no process, a Pretty thread that could not be started); the wake waits and the watch stays
 * live. Before, that wake was typed into nothing and the watch was spent.
 */
export function buildWatchDeliver(sessionService: SessionService): (terminalId: string, text: string) => DeliverResult {
  return (terminalId: string, text: string) => {
    const terminal = sessionService.getTerminal(terminalId);
    if (!terminal) return 'gone'; // watcher vanished between lookup and delivery — nothing to do
    // A shell tab would run the wake text as a command (also covers a watch stored before the route refused it).
    if (terminal.type === 'shell') return 'gone';
    if (terminal.config?.transport === 'structured' && sessionService.structuredManagerFor(terminal.type)) {
      if (sessionService.ensureStructuredAlive(terminalId) === false) return 'not-alive';
      sessionService.sendStructuredMessage(terminalId, text);
    } else {
      if (!sessionService.isPtyAlive(terminalId)) return 'not-alive';
      // Same bytes a peer message to a CLI thread uses: a bare "\n" only types a newline into the
      // input box, so the parent never woke. Bracketed paste, then one CR, submits it.
      sessionService.writeToTerminal(terminalId, ptyMessagePayload(text));
    }
    return 'delivered';
  };
}

/**
 * SessionService and its key registry. The registry is set here, before any structured manager is registered:
 * the key of a process that ended must be revoked before the listeners that may start the next process run.
 */
export function createSessionService(i: { db: Database.Database; pty: PtyLike; mcpConfigPath: string; keys: KeyRegistry; keyDir: string }): SessionService {
  const sessionService = new SessionService(i.db, i.pty, i.mcpConfigPath);
  sessionService.setKeyRegistry(i.keys, { keyDir: i.keyDir });
  return sessionService;
}

/**
 * Everything else that the daemon hands to SessionService after it is constructed. Every field is required:
 * a build that forgets one does not compile. W3-B turns these into constructor inputs of the parts
 * that SessionService is split into.
 */
export interface SessionServiceInputs {
  /** The first prompt names the thread; plugins observe every prompt. */
  onUserPrompt: Setter<'setUserPromptListener'>[0];
  onSpawned: Setter<'setSpawnListener'>[0];
  onStatusDeclared: Setter<'setStatusDeclaredListener'>[0];
  pluginInjection: Setter<'setPluginInjection'>[0];
  terminalStatusWriter: Setter<'setTerminalStatusWriter'>[0];
  /** A pick the harness refused late: the web loads the thread again. */
  onTerminalChanged: Setter<'setTerminalChangedListener'>[0];
  usageLimits: UsageLimitService;
  wakeWorkingMarker: Setter<'setWakeWorkingMarker'>[0];
  accountEnv: Setter<'setAccountEnv'>[0];
  accountDirectory: Setter<'setAccountDirectory'>[0];
  secretsServerSpec: Setter<'setSecretsServerSpec'>[0];
  integrationsSpecs: Setter<'setIntegrationsSpecs'>[0];
  toolsAwareness: Setter<'setToolsAwareness'>[0];
}

/**
 * The one place that calls the setters of SessionService. Five wires are set by their own owners, each with
 * the thing it builds: the key registry (createSessionService), the structured managers (wireHarnesses), the delivery outbox (createDeliveryOutbox),
 * the restored questions (wireRestoredQuestions) and the ledger listener (wireLedger).
 */
export function wireSessionService(s: SessionService, i: SessionServiceInputs): void {
  s.setUserPromptListener(i.onUserPrompt);
  s.setSpawnListener(i.onSpawned);
  s.setStatusDeclaredListener(i.onStatusDeclared);
  s.setPluginInjection(i.pluginInjection);
  s.setTerminalStatusWriter(i.terminalStatusWriter);
  s.setTerminalChangedListener(i.onTerminalChanged);
  s.setUsageLimitService(i.usageLimits);
  s.setWakeWorkingMarker(i.wakeWorkingMarker);
  s.setAccountEnv(i.accountEnv);
  s.setAccountDirectory(i.accountDirectory);
  s.setSecretsServerSpec(i.secretsServerSpec);
  s.setIntegrationsSpecs(i.integrationsSpecs);
  s.setToolsAwareness(i.toolsAwareness);
}
