import { describe, it, expect } from 'vitest';
import { SessionService } from '../../src/sessions/service.js';

// W3-B guard. A `set*` method that hands a collaborator to SessionService after it is built is an
// optional wire: a build that forgets the call compiles and then does nothing. The services that
// SessionService was split into take their inputs by constructor and have no such method. The
// facade keeps the wires below, each with its reason. A new one fails this test.

/** Settings of a thread. These are product actions, not wires. */
const THREAD_SETTINGS = ['setAlertsEnabled', 'setAutoArchive', 'setAutonomy', 'setBoardState', 'setThreadEffort', 'setThreadModel'];

/** A real cycle: the input is built from SessionService, or it is known only after the daemon listens. */
const CYCLE: Record<string, string> = {
  setDaemonPort: 'the port is known when the daemon listens; it can fall back to another port',
  setDaemonApi: 'the address is known when the daemon listens',
  setStatusContext: 'the server URL is known when the daemon listens',
  setDeliveryOutbox: 'the outbox delivers through SessionService.deliverOutboxRow',
  setRestoredQuestions: 'built from the status service, which is built from SessionService',
  setLedgerChangeListener: 'the listener broadcasts through the socket hub, built after SessionService',
  setUserPromptListener: 'the auto-namer and the plugin events are built from SessionService',
  setSpawnListener: 'the plugin events are built after SessionService',
  setStatusDeclaredListener: 'the plugin events are built after SessionService',
  setPluginInjection: 'the plugin host is built after SessionService',
  setTerminalStatusWriter: 'the status service is built from SessionService',
  setTerminalChangedListener: 'the broadcast is built after SessionService',
  setUsageLimitService: 'the usage-limit service resumes threads through SessionService',
  setWakeWorkingMarker: 'the status service is built from SessionService',
  setAccountEnv: 'the account store is built after SessionService',
  setAccountDirectory: 'the account store is built after SessionService',
  setSecretsServerSpec: 'the secrets service is built after SessionService',
  setIntegrationsSpecs: 'the connections service is built after SessionService',
  setToolsAwareness: 'the tools-auth service is built after SessionService',
};

/** Kept for the callers that exist: the daemon entry point and the tests set these by name. */
const COMPATIBILITY: Record<string, string> = {
  setKeyRegistry: 'createSessionService sets it at once; 20+ tests build a bare service and set a registry later',
  setOverseerMemoryHome: 'server.ts sets os.homedir(); a test sets a temp folder, a bare service sets none',
  setStructuredCommandOverride: 'test seam: a fake CLI in place of claude',
  setStructuredManager: 'alias of registerStructuredManager("claude-code")',
  setCodexStructuredManager: 'alias of registerStructuredManager("codex")',
  setGrokStructuredManager: 'alias of registerStructuredManager("grok")',
  setOpencodeStructuredManager: 'alias of registerStructuredManager("opencode")',
};

/** Private helpers whose name starts with `set`. They take no collaborator. */
const PRIVATE_HELPERS = ['setTerminalStatus', 'setThreadModelLocked', 'setThreadEffortLocked'];

const ALLOWED = new Set([...THREAD_SETTINGS, ...PRIVATE_HELPERS, ...Object.keys(CYCLE), ...Object.keys(COMPATIBILITY)]);

describe('SessionService optional wires', () => {
  it('SessionService has no set* method outside the recorded allow-list', () => {
    const setters = Object.getOwnPropertyNames(SessionService.prototype).filter((n) => /^set[A-Z]/.test(n));
    expect(setters.filter((n) => !ALLOWED.has(n))).toEqual([]);
  });

  it('every name of the allow-list still exists (remove a name when its method goes)', () => {
    const proto = Object.getOwnPropertyNames(SessionService.prototype);
    expect([...ALLOWED].filter((n) => !proto.includes(n))).toEqual([]);
  });
});
