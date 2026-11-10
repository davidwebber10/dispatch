import { describe, it, expect } from 'vitest';
import { SessionService } from '../../src/sessions/service.js';

// W3-B guard. SessionService is a facade over the services it was split into. Routes, tools and
// tests call it by these names. The list was recorded at the Wave 3 base (commit 419a5966), before the split.
const PUBLIC_AT_WAVE_BASE = [
  'activeModel', 'answerPermission', 'answerQuestionInChat', 'archive', 'batchState',
  'branchTerminal', 'codexModelDefaults', 'codexModelEfforts', 'compact', 'create',
  'createQueuedTerminal', 'createRunnerTerminal', 'createTab', 'createTerminal', 'deliverOutboxRow',
  'deliveryOutbox', 'ensureCoordinator', 'ensureStructuredAlive', 'finalOutput', 'findCoordinator',
  'get', 'getConversation', 'getPendingPermission', 'getResumeAdvice', 'getScrollbackInfo',
  'getScrollbackSize', 'getTerminal', 'handleTypedSlash', 'historyOwnedByRest', 'historyRestPageable',
  'interrupt', 'isPtyAlive', 'isStructuredTerminal', 'kickstartInterruptedAgents', 'lastAssistantTextPublic',
  'list', 'listArchivedTerminals', 'listTerminals', 'liveThreadCount', 'moveTab',
  'noteAgentCompletion', 'noteAgentLifecycle', 'noteAgentNeedsHelp', 'noteTurnOutcome', 'noteUserInput',
  'noteUserMessageToAgent', 'noteUserPrompt', 'registerStructuredManager', 'relaunch', 'relaunchTerminal',
  'removeTerminal', 'renameTerminal', 'reorderSessions', 'reorderTabs', 'reportStatus',
  'resolveTerminalFilePath', 'restartTerminal', 'restoreTerminal', 'resumeAfterUsageLimit', 'revokeEveryKey',
  'routeAgentQuestionToCoordinator', 'searchConversation', 'sendFileReference', 'sendInterimRecapNotice', 'sendStructuredMessage',
  'sendThreadMessage', 'setAccountDirectory', 'setAccountEnv', 'setAlertsEnabled', 'setAutoArchive',
  'setAutonomy', 'setBoardState', 'setCodexStructuredManager', 'setDaemonApi', 'setDaemonPort',
  'setDeliveryOutbox', 'setGrokStructuredManager', 'setIntegrationsSpecs', 'setKeyRegistry', 'setLedgerChangeListener',
  'setOpencodeStructuredManager', 'setOverseerMemoryHome', 'setPluginInjection', 'setRestoredQuestions', 'setSecretsServerSpec',
  'setSpawnListener', 'setStatusContext', 'setStatusDeclaredListener', 'setStructuredCommandOverride', 'setStructuredManager',
  'setTerminalChangedListener', 'setTerminalStatusWriter', 'setThreadEffort', 'setThreadModel', 'setToolsAwareness',
  'setUsageLimitService', 'setUserPromptListener', 'setWakeWorkingMarker', 'shutdownPreservingInterruptedTurns', 'startQueuedTerminal',
  'stop', 'stopAllTerminals', 'stopTerminal', 'structuredManagerFor', 'structuredManagerForTerminal',
  'switchAccount', 'switchTransport', 'update', 'updateTab', 'writeToTerminal',
];

describe('SessionService facade parity', () => {
  it('the recorded list holds every public name of the wave base', () => {
    expect(PUBLIC_AT_WAVE_BASE.length).toBe(110);
    expect(new Set(PUBLIC_AT_WAVE_BASE).size).toBe(110);
  });

  it('every public method name of SessionService at the wave base still exists', () => {
    const proto = SessionService.prototype as unknown as Record<string, unknown>;
    const missing = PUBLIC_AT_WAVE_BASE.filter((name) => {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      return !d || (typeof d.value !== 'function' && typeof d.get !== 'function');
    });
    expect(missing).toEqual([]);
  });
});
