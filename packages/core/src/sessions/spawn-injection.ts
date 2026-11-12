import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { getProvider } from '../providers/registry.js';
import type { StatusHooksInjection } from '../providers/types.js';
import { type McpServerSpec } from '../mcp/injection.js';
import { buildPeerPrompt } from '../overseer/prompts.js';
import { coordinatorMemoryFolders } from '../overseer/coordinator-policy.js';
import { claudeMemoryProjectDir, prepareOverseerMemory } from '../overseer/memory-scope.js';
import { isAgentType } from '../providers/agent-types.js';
import { writeGrokHome, type McpServerEntry } from '../providers/grok-home.js';
import { claudeSpinnerVerbs } from '../settings/harness-settings.js';
import { ThreadConfigStore } from './thread-config.js';
import { gatewayInfo, instructionsHome, osServerNames, osServersNote, PROMPT_INSTRUCTIONS_HARNESSES, resolveOsServerNames, rewriteInstructions, setCurrentOsServerNames } from '../os/os-servers.js';
import { PLATFORM_NAME } from '../os/platform-name.js';
import type { SessionWiring } from './session-wiring.js';
import { publishToAgent } from '../privsep/paths.js';
import { grokHomeDir } from '../providers/grok-home.js';

/** The MCP server name every eligible thread gets its Dispatch (agency) tools under. */
export const AGENCY_MCP_SERVER = 'dispatch';

/** What SpawnInjection needs. Every field is required. */
export interface SpawnInjectionDeps {
  db: Database.Database;
  /** The one writer of a thread's config (the record of the servers a thread started with). */
  configStore: ThreadConfigStore;
  /** What the daemon handed over after the services were built. Read at each spawn. */
  wiring: SessionWiring;
  /**
   * Anchor path for per-spawn MCP configs — only its DIRECTORY is used (see
   * `perTerminalMcpConfigPath`); the file at this exact path is never written
   * directly, since every spawn gets its own `thread-<terminalId>.mcp.json`
   * beside it.
   */
  mcpConfigPath: string;
}

/**
 * What a thread's process is started with, apart from its command (W3-B: moved out of
 * SessionService): the per-thread MCP config file, the Dispatch (agency) server, the peer prompt,
 * the plugins' servers, the status hooks, and the memory folders of an overseer.
 */
export class SpawnInjection {
  constructor(private readonly deps: SpawnInjectionDeps) {}

  // The inputs under the names the moved code uses.
  private get db(): Database.Database { return this.deps.db; }
  private get configStore(): ThreadConfigStore { return this.deps.configStore; }
  private get wiring(): SessionWiring { return this.deps.wiring; }
  private get mcpConfigPath(): string { return this.deps.mcpConfigPath; }
  private getTerminal(terminalId: string): terminalsDb.Terminal | null {
    const row = terminalsDb.getById(this.db, terminalId);
    return row ? terminalsDb.rowToTerminal(row) : null;
  }

  apiUrl(): string | null {
    if (this.wiring.daemonApi) return this.wiring.daemonApi;
    if (this.wiring.statusContext?.serverUrl) return this.wiring.statusContext.serverUrl.replace(/\/+$/, '');
    return this.wiring.daemonPort ? `http://127.0.0.1:${this.wiring.daemonPort}` : null;
  }

  /**
   * Add the plugins' servers and instruction blocks after Dispatch's own, and record every server
   * the thread was launched with on its row (`config.toolsAvailable`, spec section 3.3).
   */
  applyPluginInjection(terminalId: string, harness: string, specs: McpServerSpec[], prompts: string[]): void {
    if (this.wiring.pluginInjection) {
      // The thread's project: a project's skills reach its threads and not another's (spec section 8).
      const inj = this.wiring.pluginInjection(harness, this.getTerminal(terminalId)?.sessionId ?? null);
      // A plugin's server must find the daemon under every harness: Codex passes only the listed
      // variables to an MCP server, so the address rides in the spec's own env (as the agency's does).
      const api = this.apiUrl();
      const reach = { ...(api ? { DISPATCH_API: api } : {}), ...(this.wiring.daemonPort ? { DISPATCH_PORT: String(this.wiring.daemonPort) } : {}) };
      specs.push(...inj.specs.map((s) => ({ ...s, env: { ...reach, ...(s.env ?? {}) } })));
      prompts.push(...inj.prompts);
    }
    // Company-system servers last: every other server keeps its name (os/os-servers.ts).
    finalizeOsServers(specs, prompts, undefined, harness);
    if (!this.wiring.pluginInjection) return; // no plugin system wired (tests of the bare service): the row stays as it was
    const toolsAvailable = specs.map((s) => s.name);
    try { this.configStore.patch(terminalId, { toolsAvailable }); } catch { /* the record is informational */ }
    try { this.wiring.onSpawned?.(terminalId, toolsAvailable); } catch { /* observers never block a spawn */ }
  }

  /**
   * The MCP servers in the shape that Grok and OpenCode read. A server with authEnv gets the key as a
   * reference to the variable (`ref`, in that harness's own syntax), never as a literal.
   */
  mcpEntries(specs: McpServerSpec[], ref: string, opts: { http?: boolean } = {}): Record<string, McpServerEntry> {
    const out: Record<string, McpServerEntry> = {};
    for (const spec of specs) {
      // `http`: this harness takes a loopback HTTP entry with the key reference in a header (OpenCode).
      if (opts.http && spec.http && spec.authEnv) {
        out[spec.name] = { url: spec.http.url, headers: { Authorization: `Bearer ${ref}` } };
        continue;
      }
      const env = spec.authEnv ? { ...(spec.env ?? {}), DISPATCH_AUTH: ref } : spec.env;
      out[spec.name] = { command: spec.command, args: spec.args, ...(env ? { env } : {}) };
    }
    return out;
  }

  /**
   * Resolve the per-terminal status-hooks injection: ask the provider to shape
   * the plan, then do the IO (write the Claude settings file) so the build*
   * commands receive ready-to-use args. No-op until the server sets the context.
   */
  /**
   * `mcpSpecs` is only consulted by providers whose hooks and MCP servers share one
   * artifact — Grok, whose plugin directory carries both. Claude writes a settings file and
   * Codex passes argv, so for them the specs are already handled by composeInjection.
   */
  buildStatusHooks(terminalId: string, type: string, mcpSpecs: McpServerSpec[] = [], keyed = false): StatusHooksInjection | undefined {
    const ctx = this.wiring.statusContext;
    if (!ctx) return undefined;
    const provider = getProvider(type);
    const plan = provider.buildStatusHooks?.({
      serverUrl: ctx.serverUrl,
      terminalId,
      keyed,
      codexHelperPath: ctx.codexHelperPath,
      grokHelperPath: ctx.grokHelperPath,
    });
    if (!plan) return undefined;
    if (plan.grokHooks) {
      try {
        const mcpServers = this.mcpEntries(mcpSpecs, '${DISPATCH_AUTH}');
        const dir = writeGrokHome({
          dir: grokHomeDir(ctx.hooksDir, terminalId),
          realHome: path.join(os.homedir(), '.grok'),
          mcpServers,
          eventsUrl: plan.grokHooks.eventsUrl,
          hookHelperPath: plan.grokHooks.helperPath,
        });
        return dir ? { grokHomeDir: dir } : undefined;
      } catch {
        return undefined; // hooks are best-effort; never block a spawn
      }
    }
    if (plan.claudeSettings) {
      try {
        fs.mkdirSync(ctx.hooksDir, { recursive: true });
        const file = path.join(ctx.hooksDir, `${terminalId}.json`);
        // Owner-only like the other per-thread files; mode applies on create, so tighten an older file too.
        // The spinner words chosen in Settings (harness-settings.ts) ride in the same per-thread
        // settings file, so a new or restarted Claude Code thread shows them.
        const spinnerVerbs = claudeSpinnerVerbs(this.db);
        const settings = spinnerVerbs ? { ...plan.claudeSettings, spinnerVerbs } : plan.claudeSettings;
        fs.writeFileSync(file, JSON.stringify(settings, null, 2), { mode: 0o600 });
        try { fs.chmodSync(file, 0o600); } catch { /* best effort on FS that lacks chmod */ }
        publishToAgent(file);
        return { claudeSettingsPath: file };
      } catch {
        return undefined; // hooks are best-effort; never block a spawn
      }
    }
    if (plan.codexArgs) return { codexNotifyArgs: plan.codexArgs };
    return undefined;
  }

  /**
   * The session ids (external_id) of every overseer of this project, archived ones included: the
   * notes whose originSessionId is one of them are the overseer's own (the one-time copy, Unit 1).
   */
  private overseerSessionIds(sessionId: string): string[] {
    const rows = [...terminalsDb.listBySession(this.db, sessionId), ...terminalsDb.listArchivedBySession(this.db, sessionId)];
    return rows.filter((r) => {
      let cfg: Record<string, any> = {};
      try { cfg = JSON.parse(r.config || '{}'); } catch { /* default {} */ }
      return cfg.role === 'coordinator' && !!r.external_id;
    }).map((r) => r.external_id as string);
  }

  /**
   * The memory folders of a coordinator start (overseer memory scope spec 2026-10-07, Units 1-2):
   * its own, and the project's shared one, which follows the git repository of the working
   * directory (claudeMemoryProjectDir). A folder that a symlink leads out of its memory root is
   * null: it is left out of the write scope and the persona, and one error line names it. When
   * git could not resolve the repository, the shared folder is null too (and sharedProjectDir:
   * no copy, no marker), with one error line; the next start tries again (review round 2).
   */
  coordinatorMemoryFoldersFor(
    terminal: terminalsDb.TerminalRow,
    workDir: string,
  ): { own: string | null; shared: string | null; sharedProjectDir: string | null } {
    const resolved = claudeMemoryProjectDir(workDir);
    if (resolved.dir === null) {
      console.error(
        `[overseer-memory] ${terminal.id}: could not resolve the git repository of ${workDir} (${resolved.reason}); ` +
        "the project's shared memory folder is left out of this start, and the next start tries again",
      );
    }
    const { own, shared, refused } = coordinatorMemoryFolders(terminal.type, this.wiring.overseerMemoryHome ?? os.homedir(), workDir, resolved.dir);
    if (refused.length) {
      console.error(`[overseer-memory] ${terminal.id}: left out of the memory scope, because a symlink leads outside its memory root: ${refused.join(', ')}`);
    }
    return { own, shared, sharedProjectDir: resolved.dir };
  }

  /**
   * A Claude overseer's own memory folder, created (and seeded once from the project's shared
   * folder) before each start — spawn and resume alike. undefined for every other thread. Also
   * undefined, with no --settings flag, when no memory home is set (logged: that overseer has no
   * memory of its own) and when its own folder was left out of the scope (logged by
   * coordinatorMemoryFoldersFor). A failed copy never stops the start: the folder is still passed,
   * and the overseer starts with whatever the folder holds.
   */
  overseerMemoryFor(
    terminal: terminalsDb.TerminalRow,
    config: Record<string, any>,
    workDir: string,
    folders: { own: string | null; sharedProjectDir: string | null } | null,
  ): string | undefined {
    if (config.role !== 'coordinator' || terminal.type !== 'claude-code' || !folders) return undefined;
    const home = this.wiring.overseerMemoryHome;
    if (!home) {
      console.error(
        `[overseer-memory] Claude overseer ${terminal.id} starts without its own memory folder: no memory home is set ` +
        '(setOverseerMemoryHome), so it loads the project\'s shared memory as its own. No memory isolation.',
      );
      return undefined;
    }
    if (!folders.own) return undefined;
    try {
      const prepared = prepareOverseerMemory({
        home, projectDir: workDir, sharedProjectDir: folders.sharedProjectDir, overseerSessionIds: this.overseerSessionIds(terminal.session_id),
      });
      return prepared.dir ?? undefined;
    } catch (e) {
      console.warn(`[overseer-memory] could not prepare the memory folder of ${terminal.id}: ${(e as Error)?.message ?? e}`);
      return folders.own;
    }
  }

  /**
   * Per-terminal MCP config path: `thread-<terminalId>.mcp.json`, sitting beside the
   * (otherwise-unused-as-a-file) `this.mcpConfigPath` daemon dir. Every spawn — coordinator
   * or not — gets its own file. This is NOT the old per-coordinator special case: it's
   * uniform for all terminal types, because the same clobber risk exists for ANY per-thread
   * content, not just the agency server.
   *
   * Why this exists: `composeInjection` writes synchronously at spawn time, but Claude
   * only reads the file at ITS OWN process startup, well after `spawn()` returns. If every
   * terminal shared one daemon-wide path, terminal B's spawn (in a different session,
   * spawned moments later) would overwrite the exact file terminal A's not-yet-started
   * child was about to read — handing A's child B's `DISPATCH_SESSION`/`DISPATCH_TERMINAL`
   * (a project-scope violation) or silently dropping the `dispatch` server. A per-terminal
   * path makes that race structurally impossible: no two terminals ever write the same file.
   */
  perTerminalMcpConfigPath(terminalId: string): string {
    return path.join(path.dirname(this.mcpConfigPath), `thread-${terminalId}.mcp.json`);
  }

  /**
   * Delete the per-terminal MCP config file (see `perTerminalMcpConfigPath`) of a thread that is
   * deleted or archived; without this the files pile up. Safe on archive: a restore re-spawns, and
   * every spawn writes the file again before its CLI starts (spawnTerminal and spawnStructured
   * both call composeInjection). Only that one file: an id with a path separator or ".." is
   * refused, and a missing file is fine.
   */
  removeThreadMcpConfig(terminalId: string): void {
    if (!terminalId || /[\\/]/.test(terminalId) || terminalId.includes('..')) return;
    try {
      fs.unlinkSync(this.perTerminalMcpConfigPath(terminalId));
    } catch (err: any) {
      if (err?.code !== 'ENOENT') console.warn(`[sessions] could not delete the MCP config of ${terminalId}: ${err?.message ?? err}`);
    }
  }

  /**
   * Whether a thread receives the peer/agency machinery — the "dispatch" MCP server
   * (agencyServerSpec) AND the peer system-prompt block (peerPromptFor). Both call
   * sites (spawnTerminal, spawnStructured) gate on this SAME predicate so tools and
   * prompt can never drift apart: a thread with one but not the other is a bug.
   *
   * Gated by TYPE, not role — every claude-code and codex thread qualifies (plain,
   * agent, or coordinator alike; see the peer-threads design doc, decision 4:
   * "automatic, not opt-in"). A shell thread has no agent process to inject an MCP
   * server or system prompt into, so it's excluded.
   */
  isPeerEligible(type: string): boolean {
    return isAgentType(type);
  }

  /**
   * The Dispatch "agency" MCP server spec for a peer-eligible thread (see
   * isPeerEligible): points at the compiled agency-mcp.js and carries the caller's
   * identity — DISPATCH_SESSION (this project, so threads it spawns land in the same
   * project) and DISPATCH_TERMINAL (which thread is calling — consumed by the
   * peer-thread tools for self-identification) and DISPATCH_SPAWN_DEPTH (this
   * thread's own spawn-chain depth, so spawn_agent/queue_agent can enforce
   * MAX_SPAWN_DEPTH and stamp the right depth on any child, without an extra
   * round-trip to the daemon). Pushed into the `specs` array handed to
   * composeInjection ALONGSIDE the Doppler/integrations specs — no more bespoke
   * config-file post-processing — so composeInjection's single spec list produces
   * both the Claude --mcp-config JSON and codex's `-c mcp_servers.*` args, and codex
   * threads get the server too, not just claude-code ones. The resulting config is
   * written to a PER-TERMINAL path (see `perTerminalMcpConfigPath`), never the
   * shared daemon-wide one.
   */
  agencyServerSpec(terminalId: string, sessionId: string, spawnDepth: number, authEnv = false): McpServerSpec {
    const agencyPath = fileURLToPath(new URL('../overseer/agency-mcp.js', import.meta.url));
    const api = this.apiUrl();
    return {
      name: AGENCY_MCP_SERVER,
      command: 'node',
      args: [agencyPath],
      env: {
        DISPATCH_SESSION: sessionId,
        DISPATCH_PORT: String(this.wiring.daemonPort ?? process.env.PORT ?? 3456),
        DISPATCH_TERMINAL: terminalId,
        DISPATCH_SPAWN_DEPTH: String(spawnDepth),
        ...(api ? { DISPATCH_API: api } : {}),
      },
      ...(authEnv ? { authEnv: true } : {}),
    };
  }

  /**
   * Build the peer-context system-prompt block for one thread: its project's name
   * and working dir, its own label + id, and a roster snapshot of its live (non-
   * archived) project peers — every OTHER terminal in the same session, self
   * excluded. Callers push the result into the `prompts` array fed to
   * composeInjection under the SAME gate as agencyServerSpec (isPeerEligible — see
   * the call sites in spawnTerminal/spawnStructured).
   */
  peerPromptFor(terminal: terminalsDb.TerminalRow): string {
    const session = sessionsDb.getById(this.db, terminal.session_id);
    const workingDir = terminal.working_dir || session?.working_dir || '';
    const peers = terminalsDb.listBySession(this.db, terminal.session_id)
      .filter((t) => t.id !== terminal.id)
      .map((t) => ({ label: t.label, type: t.type, status: t.status }));
    return buildPeerPrompt({
      projectName: session?.name || terminal.session_id,
      workingDir,
      selfLabel: terminal.label,
      selfId: terminal.id,
      peers,
    });
  }
}

/**
 * The person's own MCP server names in their Claude Code user config (`~/.claude.json` mcpServers),
 * cached by the file's mtime. A company-system server never takes one of these names.
 */
let userServersCache: { mtimeMs: number; names: string[] } | null = null;
export function userClaudeServerNames(file = path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json')): string[] {
  try {
    const st = fs.statSync(file);
    if (userServersCache && userServersCache.mtimeMs === st.mtimeMs) return userServersCache.names;
    const servers = JSON.parse(fs.readFileSync(file, 'utf8'))?.mcpServers;
    const names = servers && typeof servers === 'object' ? Object.keys(servers) : [];
    userServersCache = { mtimeMs: st.mtimeMs, names };
    return names;
  } catch { return []; }
}

/**
 * Company-system servers of one spawn (os/os-servers.ts), in place: an OS server whose name another
 * server already has becomes `os-<name>`; the names go to smart approvals; one line tells the thread
 * which servers are company systems.
 */
export function finalizeOsServers(specs: McpServerSpec[], prompts: string[], taken: readonly string[] = userClaudeServerNames(), harness?: string, info = gatewayInfo()): void {
  if (!specs.some((s) => s.osSystem)) return;
  const resolved = resolveOsServerNames(specs, taken);
  specs.splice(0, specs.length, ...resolved);
  setCurrentOsServerNames(osServerNames(resolved));
  const note = osServersNote(resolved, PLATFORM_NAME);
  if (note) prompts.push(note);
  // A harness that drops MCP `instructions` gets the gateway's text in its prompt, named as it sees the tools.
  if (harness && PROMPT_INSTRUCTIONS_HARNESSES.includes(harness) && info.instructions) {
    const serverOf = new Map(resolved.filter((s) => s.osSystem).map((s) => [s.osSystem!, s.name]));
    const tools = new Map([...info.tools].filter(([sys]) => serverOf.has(sys)));
    if (instructionsHome([...serverOf.keys()])) prompts.push(rewriteInstructions(info.instructions, tools, (sys) => serverOf.get(sys) ?? sys));
  }
}
