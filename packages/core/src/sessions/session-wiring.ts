import type { UsageLimitService } from '../limits/service.js';
import type { McpServerSpec } from '../mcp/injection.js';
import type { ThreadKeys } from './thread-keys.js';

export interface StatusContext {
  serverUrl: string;
  /** Directory where per-terminal Claude hook settings files are written. */
  hooksDir: string;
  /** Absolute path to the Codex notify helper script. */
  codexHelperPath: string;
  /** Absolute path to the Grok hook helper script. */
  grokHelperPath?: string;
}

/**
 * What the daemon hands to the session services after they are built (W3-B). Each value comes
 * from a service that is built from SessionService, or is known only when the daemon listens, so
 * it cannot be a constructor input (tests/sessions/no-optional-wire.test.ts has the reason of each
 * setter). SessionService owns the one object; its setters write it, and the parts it was split
 * into read it at each use. A value that was never set keeps the behaviour of a bare service.
 */
export interface SessionWiring {
  /** Supplies the Doppler MCP spec for spawned CLIs; set by the server wiring. */
  secretsServerSpec: (() => { spec: McpServerSpec | null; prompt: string | null }) | null;
  /** Supplies the catalog MCP specs for spawned CLIs; set by the server wiring. */
  integrationsSpecs: (() => McpServerSpec[]) | null;
  /** Plugins' MCP servers and instruction blocks per harness (docs/superpowers/specs/2026-11-07-plugins-design.md, section 3). */
  pluginInjection: ((harness: string, sessionId: string | null) => { specs: McpServerSpec[]; prompts: string[]; toolNames: string[] }) | null;
  usageLimits?: UsageLimitService;
  statusContext: StatusContext | null;
  /** Supplies a tools-awareness note injected into the developer instructions; set by server wiring. */
  toolsAwareness?: () => string | null;
  /** The per-thread account env (multi-account spec 2026-11-06): the thread's Claude token or Codex home. Set by the server wiring. */
  accountEnv?: (type: string, config: Record<string, unknown>) => Record<string, string>;
  /** The accounts a thread type can run on (multi-account): validates a switch, and names the default an unpinned thread uses. */
  accountDirectory?: { has: (type: string, accountId: string) => boolean; defaultId: (type: string) => string };
  /** Override for structured command (test seam: lets tests spawn fake-claude instead of real claude). */
  structuredCommandOverride?: { command: string; args: string[] };
  /**
   * The home folder that holds the Claude overseers' own memory folders (overseer memory scope
   * spec 2026-10-07, Unit 1). startServer sets os.homedir(); tests set a fs.mkdtempSync folder.
   * Unset → no memory folder is created, no note is copied and no --settings flag is passed, so a
   * service a test builds without it never writes into a real home.
   */
  overseerMemoryHome: string | null;
  /**
   * The port the daemon actually bound. The agency helper sends its calls here, so it must not
   * guess from PORT: the daemon can fall back to another port when its first choice is taken.
   */
  daemonPort: number | null;
  /**
   * The daemon's own address for first-party callers (loopback, bound port, base path). It goes
   * into the agency MCP env as DISPATCH_API: the only place a thread key may be sent to. Not a secret.
   */
  daemonApi: string | null;
  /**
   * Per-thread keys (stage 1). Unset until the daemon (or a test) hands in the registry; an unset
   * service mints nothing and every spawn runs as before. The exits of the PTY manager and of
   * every structured manager reach `ThreadKeys` from here, so a test service needs no extra wiring.
   */
  threadKeys: ThreadKeys | null;
  onSpawned: ((terminalId: string, toolsAvailable: string[]) => void) | null;
}

/** The wiring of a service that nothing was handed to yet. */
export function emptySessionWiring(): SessionWiring {
  return { secretsServerSpec: null, integrationsSpecs: null, pluginInjection: null, statusContext: null, overseerMemoryHome: null, daemonPort: null, daemonApi: null, threadKeys: null, onSpawned: null };
}
