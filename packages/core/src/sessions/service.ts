import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import * as appState from '../db/app-state.js';
import { getProvider } from '../providers/registry.js';
import { PTYManager } from '../pty/manager.js';
import type { Session, CreateSessionInput } from '../types.js';
import { rowToSession } from '../types.js';
import type { TerminalType } from '../db/terminals.js';
import type { StatusHooksInjection, SecretsMcpInjection } from '../providers/types.js';
import { composeInjection, type McpServerSpec } from '../mcp/injection.js';
import { parseClaudeTranscript, type ConvItem } from '../conversation/transcript.js';
import { platform } from '../platform/index.js';
import { systemPromptFor } from '../overseer/prompts.js';
import { readSessionBackfill } from './cc-sessions.js';

interface StatusContext {
  serverUrl: string;
  /** Directory where per-terminal Claude hook settings files are written. */
  hooksDir: string;
  /** Absolute path to the Codex notify helper script. */
  codexHelperPath: string;
}

export class SessionService {
  /** Supplies the Doppler MCP spec for spawned CLIs; set by the server wiring. */
  private secretsServerSpec: (() => { spec: McpServerSpec | null; prompt: string | null }) | null = null;
  /** Supplies the catalog MCP specs for spawned CLIs; set by the server wiring. */
  private integrationsSpecs: (() => McpServerSpec[]) | null = null;
  /** How spawned CLIs phone home with lifecycle events; set by the server wiring. */
  private statusContext: StatusContext | null = null;
  /** Supplies a tools-awareness note injected into the developer instructions; set by server wiring. */
  private toolsAwareness?: () => string | null;
  /** Drives structured (stream-json) sessions for claude-code threads; set by server wiring. */
  private structuredManager?: import('../structured/manager.js').StructuredSessionManager;
  /** Override for structured command (test seam: lets tests spawn fake-claude instead of real claude). */
  private structuredCommandOverride?: { command: string; args: string[] };

  constructor(
    private db: Database.Database,
    private ptyManager: PTYManager,
    /** Path for the combined MCP config written at spawn time. Defaults to ~/.dispatch/mcp.json. */
    private readonly mcpConfigPath: string = path.join(os.homedir(), '.dispatch', 'mcp.json'),
  ) {}

  setSecretsServerSpec(fn: () => { spec: McpServerSpec | null; prompt: string | null }): void {
    this.secretsServerSpec = fn;
  }

  setIntegrationsSpecs(fn: () => McpServerSpec[]): void {
    this.integrationsSpecs = fn;
  }

  setToolsAwareness(fn: () => string | null): void {
    this.toolsAwareness = fn;
  }

  setStructuredManager(m: import('../structured/manager.js').StructuredSessionManager): void {
    this.structuredManager = m;
    // Persist the claude session_id (surfaced from the structured init event) onto the
    // terminal's external_id, mirroring how the PTY path captures session ids. This is
    // what lets us resume the SAME conversation after a daemon restart. First-write-wins
    // (a `-r` resume keeps the same id, so we never need to overwrite).
    m.on('session', (terminalId: string, sessionId: string) => {
      try {
        const t = terminalsDb.getById(this.db, terminalId);
        if (t && !t.external_id && sessionId) terminalsDb.updateExternalId(this.db, terminalId, sessionId);
      } catch { /* best effort */ }
    });
  }

  setStructuredCommandOverride(cmd: { command: string; args: string[] }): void { this.structuredCommandOverride = cmd; }

  setStatusContext(ctx: StatusContext): void {
    this.statusContext = ctx;
  }

  /**
   * Resolve the per-terminal status-hooks injection: ask the provider to shape
   * the plan, then do the IO (write the Claude settings file) so the build*
   * commands receive ready-to-use args. No-op until the server sets the context.
   */
  private buildStatusHooks(terminalId: string, type: string): StatusHooksInjection | undefined {
    const ctx = this.statusContext;
    if (!ctx) return undefined;
    const provider = getProvider(type);
    const plan = provider.buildStatusHooks?.({
      serverUrl: ctx.serverUrl,
      terminalId,
      codexHelperPath: ctx.codexHelperPath,
    });
    if (!plan) return undefined;
    if (plan.claudeSettings) {
      try {
        fs.mkdirSync(ctx.hooksDir, { recursive: true });
        const file = path.join(ctx.hooksDir, `${terminalId}.json`);
        fs.writeFileSync(file, JSON.stringify(plan.claudeSettings, null, 2));
        return { claudeSettingsPath: file };
      } catch {
        return undefined; // hooks are best-effort; never block a spawn
      }
    }
    if (plan.codexArgs) return { codexNotifyArgs: plan.codexArgs };
    return undefined;
  }

  create(input: CreateSessionInput): Session {
    const id = uuid();
    const name = input.name || 'New Project';

    sessionsDb.create(this.db, {
      id,
      provider: input.provider || 'claude-code',
      name,
      workingDir: input.workingDir || '~',
    });

    return rowToSession(sessionsDb.getById(this.db, id)!);
  }

  get(id: string): Session | null {
    const row = sessionsDb.getById(this.db, id);
    return row ? rowToSession(row) : null;
  }

  list(status?: string): Session[] {
    return sessionsDb.list(this.db, status).map(rowToSession);
  }

  reorderSessions(order: string[]): void {
    for (let i = 0; i < order.length; i++) {
      this.db.prepare('UPDATE sessions SET sort_order = ? WHERE id = ?').run(i, order[i]);
    }
  }

  update(id: string, fields: { name?: string; notes?: string; tags?: string[] }): Session | null {
    sessionsDb.update(this.db, id, fields);
    return this.get(id);
  }

  relaunch(id: string): Session | null {
    const row = sessionsDb.getById(this.db, id);
    if (!row) return null;

    // Find the first terminal for this session to relaunch
    const terminals = terminalsDb.listBySession(this.db, id);
    if (terminals.length > 0) {
      const terminal = terminals[0];
      this.relaunchTerminal(terminal.id);
    } else {
      // Legacy: no terminal records yet, use session-level relaunch
      if (this.ptyManager.isAlive(id)) return rowToSession(row);

      const provider = getProvider(row.provider);
      try {
        const cmd = row.external_id
          ? provider.buildResumeCommand({ externalSessionId: row.external_id, workDir: row.working_dir })
          : provider.buildNewCommand({ workDir: row.working_dir });

        const pid = this.ptyManager.spawn(id, cmd.command, cmd.args, row.working_dir);
        sessionsDb.updatePid(this.db, id, pid);
        sessionsDb.setError(this.db, id, '');
      } catch (err: any) {
        sessionsDb.setError(this.db, id, err.message);
      }
    }

    return rowToSession(sessionsDb.getById(this.db, id)!);
  }

  stop(id: string): void {
    // Stop all terminals for this session
    const terminals = terminalsDb.listBySession(this.db, id);
    for (const terminal of terminals) {
      this.ptyManager.kill(terminal.id);
      this.structuredManager?.kill(terminal.id);
      terminalsDb.updatePid(this.db, terminal.id, null);
    }

    // Legacy: also kill by session ID in case no terminal records
    this.ptyManager.kill(id);
    sessionsDb.updateStatus(this.db, id, 'waiting');
    sessionsDb.updatePid(this.db, id, null);
  }

  archive(id: string): void {
    // Kill all terminals
    const terminals = terminalsDb.listBySession(this.db, id);
    for (const terminal of terminals) {
      if (this.ptyManager.isAlive(terminal.id)) this.ptyManager.kill(terminal.id);
      this.structuredManager?.kill(terminal.id);
    }
    terminalsDb.removeBySession(this.db, id);

    if (this.ptyManager.isAlive(id)) this.ptyManager.kill(id);
    sessionsDb.archive(this.db, id);
  }

  // --- Terminal-level operations ---

  createTerminal(sessionId: string, type: TerminalType, label?: string, skipPermissions?: boolean, workingDir?: string, externalId?: string, config?: Record<string, any>): terminalsDb.Terminal {
    const session = sessionsDb.getById(this.db, sessionId);
    if (!session) throw new Error('Session not found');

    const resolvedDir = workingDir
      ? workingDir.replace(/^~/, os.homedir())
      : session.working_dir;

    if (workingDir) {
      appState.set(this.db, 'last_directory', resolvedDir);
    }

    const terminalId = uuid();
    const displayLabel = label || this.defaultTerminalLabel(sessionId, type);

    terminalsDb.create(this.db, {
      id: terminalId,
      sessionId,
      type,
      label: displayLabel,
      skipPermissions,
      workingDir: resolvedDir,
      externalId,
      config,
    });

    try {
      this.spawnTerminal(terminalId);
    } catch (err: any) {
      terminalsDb.remove(this.db, terminalId);
      throw new Error(`Failed to start ${displayLabel}: ${err.message}`);
    }

    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  /**
   * Create a terminal that launches the provider in autonomous "runner" mode:
   * the prompt is passed as a launch arg so the agent executes it to completion
   * (and the process exits when done) instead of opening an interactive REPL
   * with text typed into it. The prompt + runner flag are persisted in the
   * terminal's config so a relaunch re-runs the same prompt. Used by agent runs.
   */
  createRunnerTerminal(sessionId: string, type: TerminalType, label: string | undefined, workingDir: string | undefined, prompt: string): terminalsDb.Terminal {
    const session = sessionsDb.getById(this.db, sessionId);
    if (!session) throw new Error('Session not found');

    const resolvedDir = workingDir
      ? workingDir.replace(/^~/, os.homedir())
      : session.working_dir;

    if (workingDir) {
      appState.set(this.db, 'last_directory', resolvedDir);
    }

    const terminalId = uuid();
    const displayLabel = label || this.defaultTerminalLabel(sessionId, type);

    terminalsDb.create(this.db, {
      id: terminalId,
      sessionId,
      type,
      label: displayLabel,
      skipPermissions: true,
      workingDir: resolvedDir,
      config: { runner: true, runnerPrompt: prompt },
    });

    try {
      this.spawnTerminal(terminalId);
    } catch (err: any) {
      terminalsDb.remove(this.db, terminalId);
      throw new Error(`Failed to start ${displayLabel}: ${err.message}`);
    }

    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  /**
   * Branch (fork) a Claude Code thread into a NEW thread. Resolves the source
   * thread's session id, then creates a terminal that forks it on first spawn
   * (config.branchFrom → provider.buildBranchCommand → `claude -r <id> --fork-session`).
   * The original thread is untouched. Throws with `.status = 422` if the source
   * doesn't have a session id yet.
   */
  branchTerminal(sourceTerminalId: string): terminalsDb.Terminal {
    const source = terminalsDb.getById(this.db, sourceTerminalId);
    if (!source) throw new Error('Thread not found');
    const provider = getProvider(source.type);
    if (!provider.buildBranchCommand) throw new Error('This thread type cannot be branched');
    const dir = source.working_dir || sessionsDb.getById(this.db, source.session_id)?.working_dir;
    if (!dir) throw new Error('Session not found');
    const sourceSessionId = source.external_id || this.recoverSessionId(sourceTerminalId, dir);
    if (!sourceSessionId) {
      const e: any = new Error('Thread has no session yet — let it start, then branch.');
      e.status = 422;
      throw e;
    }

    const terminalId = uuid();
    terminalsDb.create(this.db, {
      id: terminalId,
      sessionId: source.session_id,
      type: source.type,
      label: `${source.label} (branch)`,
      skipPermissions: true,
      workingDir: dir,
      config: { branchFrom: sourceSessionId },
    });
    try {
      this.spawnTerminal(terminalId);
    } catch (err: any) {
      terminalsDb.remove(this.db, terminalId);
      throw new Error(`Failed to branch: ${err.message}`);
    }
    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  // Create a non-PTY tab (browser, notes)
  createTab(sessionId: string, type: string, label: string, config?: Record<string, any>): terminalsDb.Terminal {
    const session = sessionsDb.getById(this.db, sessionId);
    if (!session) throw new Error('Session not found');

    const tabId = uuid();
    terminalsDb.create(this.db, {
      id: tabId,
      sessionId,
      type,
      label,
      config,
    });
    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, tabId)!);
  }

  // Update any tab (rename, update config)
  updateTab(tabId: string, fields: { label?: string; config?: Record<string, any> }): terminalsDb.Terminal | null {
    const row = terminalsDb.getById(this.db, tabId);
    if (!row) return null;
    if (fields.label) terminalsDb.updateLabel(this.db, tabId, fields.label);
    if (fields.config) terminalsDb.updateConfig(this.db, tabId, fields.config);
    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, tabId)!);
  }

  reorderTabs(sessionId: string, order: string[]): void {
    for (let i = 0; i < order.length; i++) {
      terminalsDb.updateSortOrder(this.db, order[i], i);
    }
  }

  moveTab(tabId: string, toSessionId: string): terminalsDb.Terminal | null {
    const row = terminalsDb.getById(this.db, tabId);
    if (!row) return null;
    terminalsDb.updateSessionId(this.db, tabId, toSessionId);
    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, tabId)!);
  }

  listTerminals(sessionId: string): terminalsDb.Terminal[] {
    // Exclude agent-run "runner" terminals: they belong to the agent run's
    // polished RunnerView (steps/plan/HUD), not the project's thread list — where
    // opening one would just show the raw stream-json the runner emits.
    return terminalsDb.listBySession(this.db, sessionId)
      .map(terminalsDb.rowToTerminal)
      .filter((t) => !(t.config as { runner?: boolean } | undefined)?.runner);
  }

  getTerminal(terminalId: string): terminalsDb.Terminal | null {
    const row = terminalsDb.getById(this.db, terminalId);
    return row ? terminalsDb.rowToTerminal(row) : null;
  }

  /**
   * Read + parse a WINDOW of the live transcript for a terminal's session (View).
   * The transcript is addressed by complete-JSONL-line index:
   *   - default (initial load): the most recent `limit` lines.
   *   - `since`: lines after index `since` (polling for new messages at the bottom).
   *   - `before`: the `limit` lines ending just before index `before` (loading
   *     older history at the top, for reverse infinite scroll).
   * Returns the parsed `items`, `cursor` (= total line count, the bottom edge for
   * polling), `startLine` (top edge of the returned window), and `hasMore`
   * (whether older lines exist above the window). Claude Code only for now.
   */
  getConversation(
    terminalId: string,
    opts: { since?: number; before?: number; limit?: number } = {},
  ): { items: ConvItem[]; cursor: number; startLine: number; hasMore: boolean; unsupported?: boolean } {
    const empty = { items: [] as ConvItem[], cursor: 0, startLine: 0, hasMore: false };
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return empty;
    if (terminal.type !== 'claude-code') return { ...empty, unsupported: true };

    const session = sessionsDb.getById(this.db, terminal.session_id);
    const workDir = terminal.working_dir || session?.working_dir;
    if (!workDir) return empty;

    const dir = platform.claudeProjectDir(workDir);
    // external_id is normally captured at spawn; when it wasn't, recover it from the
    // project's transcript files so the thread still renders in View.
    const sessionId = terminal.external_id || this.recoverSessionId(terminalId, dir);
    if (!sessionId) return empty;

    let raw: string;
    try { raw = fs.readFileSync(path.join(dir, `${sessionId}.jsonl`), 'utf8'); } catch { return empty; }

    // Consume only complete lines (the trailing element is an empty string after a
    // final newline, or a half-written entry) so we never parse a partial record.
    const usable = raw.split('\n').slice(0, -1);
    const total = usable.length;
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 200;

    let start: number;
    let end: number;
    if (opts.before !== undefined && opts.before > 0) {       // older window (scroll up)
      end = Math.min(opts.before, total);
      start = Math.max(0, end - limit);
    } else if (opts.since !== undefined && opts.since > 0) {  // new lines (poll)
      start = Math.min(opts.since, total);
      end = total;
    } else {                                                  // initial: most recent `limit`
      end = total;
      start = Math.max(0, total - limit);
    }

    // Parse per line so each item carries its source line index (enables jump-to).
    const items: ConvItem[] = [];
    for (let i = start; i < end; i++) {
      for (const it of parseClaudeTranscript(usable[i])) items.push({ ...it, line: i });
    }
    return { items, cursor: total, startLine: start, hasMore: start > 0 };
  }

  /**
   * Full-history text search over a terminal's transcript. Returns matches with
   * their source line index (so View can load + scroll to that spot) and a short
   * snippet around the match. Newest matches first, capped for response size.
   */
  searchConversation(terminalId: string, query: string, limit = 200): { matches: { line: number; kind: string; snippet: string }[] } {
    const q = query.trim().toLowerCase();
    if (!q) return { matches: [] };
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal || terminal.type !== 'claude-code') return { matches: [] };
    const session = sessionsDb.getById(this.db, terminal.session_id);
    const workDir = terminal.working_dir || session?.working_dir;
    if (!workDir) return { matches: [] };
    const dir = platform.claudeProjectDir(workDir);
    const sessionId = terminal.external_id || this.recoverSessionId(terminalId, dir);
    if (!sessionId) return { matches: [] };
    let raw: string;
    try { raw = fs.readFileSync(path.join(dir, `${sessionId}.jsonl`), 'utf8'); } catch { return { matches: [] }; }

    const usable = raw.split('\n').slice(0, -1);
    const matches: { line: number; kind: string; snippet: string }[] = [];
    for (let i = usable.length - 1; i >= 0 && matches.length < limit; i--) { // newest first
      for (const it of parseClaudeTranscript(usable[i])) {
        const hay = `${it.text ?? ''} ${it.toolTitle ?? ''} ${it.toolDetail ?? ''}`;
        const at = hay.toLowerCase().indexOf(q);
        if (at >= 0) {
          matches.push({ line: i, kind: it.kind, snippet: snippetAround(hay, at, q.length) });
          break; // one match per line is enough
        }
      }
    }
    return { matches };
  }

  /**
   * Recover a missing transcript link: pick the newest *.jsonl in the project's
   * Claude transcript dir, and persist it as the terminal's external_id when it's
   * the only one (unambiguous) so resume + future loads work too.
   */
  private recoverSessionId(terminalId: string, dir: string): string | null {
    let files: { id: string; m: number }[];
    try {
      files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ id: f.replace(/\.jsonl$/, ''), m: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
    } catch { return null; }
    if (!files.length) return null;
    if (files.length === 1) {
      try { terminalsDb.updateExternalId(this.db, terminalId, files[0].id); } catch { /* best effort */ }
    }
    return files[0].id;
  }

  relaunchTerminal(terminalId: string): terminalsDb.Terminal | null {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return null;
    // Non-PTY tabs don't need relaunching
    if (!terminalsDb.isPtyType(terminal.type)) return terminalsDb.rowToTerminal(terminal);
    if (this.ptyManager.isAlive(terminalId)) return terminalsDb.rowToTerminal(terminal);

    const session = sessionsDb.getById(this.db, terminal.session_id);
    if (!session) return null;

    try {
      this.spawnTerminal(terminalId);
    } catch (err: any) {
      terminalsDb.updatePid(this.db, terminalId, null);
      terminalsDb.updateStatus(this.db, terminalId, 'error');
    }

    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  /** Restart a thread: kill the running process (if any) and re-spawn it fresh. */
  async restartTerminal(terminalId: string): Promise<terminalsDb.Terminal | null> {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return null;
    if (!terminalsDb.isPtyType(terminal.type)) return terminalsDb.rowToTerminal(terminal);

    if (this.ptyManager.isAlive(terminalId)) {
      // Wait for the old process to fully exit before respawning, so its async
      // exit handler can't delete the fresh PTY out from under us.
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; this.ptyManager.off('exit', onExit); resolve(); } };
        const onExit = (id: string) => { if (id === terminalId) finish(); };
        this.ptyManager.on('exit', onExit);
        this.ptyManager.kill(terminalId);
        setTimeout(finish, 3000);
      });
    }
    return this.relaunchTerminal(terminalId);
  }

  stopTerminal(terminalId: string): void {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return;
    this.ptyManager.kill(terminalId);
    this.structuredManager?.kill(terminalId);
    terminalsDb.updatePid(this.db, terminalId, null);
  }

  sendStructuredMessage(terminalId: string, text: string): void {
    // Lazily resume a thread that died on a daemon restart (resumes the same claude
    // conversation when an external_id was captured) before delivering the message.
    if (!this.structuredManager?.isAlive(terminalId)) this.ensureStructuredAlive(terminalId);
    if (!this.structuredManager?.isAlive(terminalId)) throw new Error('no structured session for terminal');
    this.structuredManager.sendMessage(terminalId, text);
  }

  /**
   * The membrane's "up" channel. Inject a directive into the coordinator that supervises
   * `agentTerminalId`, if any: an agent never bothers the human directly — its questions and
   * lifecycle events surface to its project's coordinator (Dispatch), which decides what to do
   * (answer, ask the human itself, re-plan). Returns true when a live coordinator received the
   * note; false when the thread isn't a typed agent or the project has no coordinator.
   */
  private notifyCoordinatorOfAgent(agentTerminalId: string, note: string): boolean {
    const agent = terminalsDb.getById(this.db, agentTerminalId);
    if (!agent) return false;
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(agent.config || '{}'); } catch { /* default {} */ }
    if (cfg.role !== 'agent') return false; // only agents escalate UP; coordinators/plain → human
    const coordinator = terminalsDb.listBySession(this.db, agent.session_id)
      .map(terminalsDb.rowToTerminal)
      .find((t) => t.type === 'claude-code' && !t.archivedAt && t.id !== agentTerminalId && t.config?.role === 'coordinator');
    if (!coordinator) return false;
    try {
      this.ensureStructuredAlive(coordinator.id); // a daemon restart may have killed it
      this.sendStructuredMessage(coordinator.id, note);
      return true;
    } catch { return false; }
  }

  /** Format an agent's pending AskUserQuestion as a directive the coordinator can act on. */
  private formatAgentQuestion(agentId: string, label: string, mission: string | null, questions: any[]): string {
    const qs = Array.isArray(questions) ? questions : [];
    const lines = qs.map((q: any, i: number) => {
      const header = (q?.header ?? `Q${i + 1}`).toString();
      const question = (q?.question ?? '').toString();
      const opts = Array.isArray(q?.options)
        ? q.options.map((o: any) => (typeof o === 'string' ? o : (o?.label ?? o?.name ?? ''))).filter(Boolean)
        : [];
      return `  • [${header}] ${question}${opts.length ? `\n    options: ${opts.join(' | ')}` : ''}`;
    });
    const headers = qs.map((q: any, i: number) => (q?.header ?? `Q${i + 1}`).toString());
    const exampleAnswers = headers.length
      ? `{ ${headers.map((h) => `"${h}": "<chosen option>"`).join(', ')} }`
      : '{ "<header>": "<chosen option>" }';
    return (
      `🔔 Your agent "${label}"${mission ? ` (mission "${mission}")` : ''} is PAUSED waiting on you to ` +
      `answer a question (it cannot proceed until you do):\n${lines.join('\n')}\n\n` +
      `Decide based on the mission and answer it now by calling:\n` +
      `answer_agent({ agentId: "${agentId}", answers: ${exampleAnswers} })\n` +
      `Pick from the listed options. Only raise it to the human yourself if you genuinely cannot decide.`
    );
  }

  /**
   * Membrane routing for an agent's pending AskUserQuestion: forward it to the project's
   * coordinator instead of the human. Returns true when a coordinator was notified (the caller
   * should keep the agent "working", not mark it needs_input); false to fall back to surfacing
   * the question to the human (the pending isn't a question, the thread isn't an agent, or the
   * project has no coordinator). Plain gated tools are never routed up — only questions.
   */
  routeAgentQuestionToCoordinator(agentTerminalId: string, pending: { toolName?: string; questions?: any[] }): boolean {
    if (!pending?.questions?.length) return false; // only AskUserQuestion escalates up; plain tools → human
    const agent = terminalsDb.getById(this.db, agentTerminalId);
    if (!agent) return false;
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(agent.config || '{}'); } catch { /* default {} */ }
    const mission = typeof cfg.mission === 'string' && cfg.mission.trim() ? cfg.mission.trim() : null;
    const note = this.formatAgentQuestion(agentTerminalId, agent.label || 'agent', mission, pending.questions);
    return this.notifyCoordinatorOfAgent(agentTerminalId, note);
  }

  /**
   * Tell the project's coordinator that the user just stopped or interrupted one of its agents,
   * so Dispatch notices and reacts (checks in about why, re-plans) rather than silently losing
   * the agent. No-op when the thread isn't a typed agent or there's no coordinator.
   */
  noteAgentLifecycle(agentTerminalId: string, kind: 'stopped' | 'interrupted'): void {
    const agent = terminalsDb.getById(this.db, agentTerminalId);
    if (!agent) return;
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(agent.config || '{}'); } catch { /* default {} */ }
    if (cfg.role !== 'agent') return;
    const mission = typeof cfg.mission === 'string' && cfg.mission.trim() ? cfg.mission.trim() : null;
    const note =
      `⚠️ The user just ${kind} your agent "${agent.label || 'agent'}"${mission ? ` (mission "${mission}")` : ''} ` +
      `[agentId ${agentTerminalId}] while it was working. They likely want a change of direction or noticed ` +
      `something off. Check in with the user about why and adjust: re-spawn with new guidance, redirect the ` +
      `work, or stand down. Do not silently ignore this.`;
    this.notifyCoordinatorOfAgent(agentTerminalId, note);
  }

  /** The agent's most recent assistant text, pulled live from the structured event ring
   *  (no transcript-file latency), truncated for a nudge. '' when there's none yet. */
  private lastAssistantText(terminalId: string, max = 600): string {
    const events = (this.structuredManager?.getEvents(terminalId) ?? []) as any[];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e?.type === 'assistant' && Array.isArray(e.message?.content)) {
        const text = e.message.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join('').trim();
        if (text) return text.length > max ? text.slice(0, max) + '…' : text;
      }
    }
    return '';
  }

  /**
   * An agent's turn just completed (the `result` event). Push an IMMEDIATE, concise completion
   * notice to its coordinator (the closed orchestration loop): a one-line summary from the agent's
   * last output + a pointer to read_agent for the full transcript, so Dispatch ingests the result
   * and decides the next step instead of forgetting the agent. No-op for non-agents / no coordinator.
   */
  noteAgentCompletion(agentTerminalId: string): void {
    const agent = terminalsDb.getById(this.db, agentTerminalId);
    if (!agent) return;
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(agent.config || '{}'); } catch { /* default {} */ }
    if (cfg.role !== 'agent') return;
    const mission = typeof cfg.mission === 'string' && cfg.mission.trim() ? cfg.mission.trim() : null;
    const summary = this.lastAssistantText(agentTerminalId);
    const note =
      `✅ Your agent "${agent.label || 'agent'}"${mission ? ` (mission "${mission}")` : ''} ` +
      `[agentId ${agentTerminalId}] just finished a turn.\n` +
      (summary ? `Its latest output: ${summary}\n\n` : '') +
      `Read its full work with read_agent({ agentId: "${agentTerminalId}" }), then decide the next step — ` +
      `ingest the result, hand it to another agent, spawn a follow-up, or report back to the user. Keep this ` +
      `brief unless it needs action; the user's own messages are always your top priority.`;
    this.notifyCoordinatorOfAgent(agentTerminalId, note);
  }

  /** The gated tool/question a structured AGENT thread is blocked on, or null. */
  getPendingPermission(terminalId: string): import('../structured/manager.js').PendingPermission | null {
    return this.structuredManager?.getPending(terminalId) ?? null;
  }

  /**
   * Resolve a structured thread's pending gated tool. `allow` echoes the original
   * input back to the tool, folding in the original `questions` and any AskUserQuestion
   * `answers` map; `deny` sends a message. Returns false when nothing is pending.
   */
  answerPermission(
    terminalId: string,
    requestId: string,
    opts: { decision: 'allow' | 'deny'; answers?: Record<string, string>; message?: string },
  ): boolean {
    if (!this.structuredManager) return false;
    const pending = this.structuredManager.getPending(terminalId);
    if (!pending) return false;
    if (opts.decision === 'allow') {
      const updatedInput = {
        ...(pending.input ?? {}),
        ...(pending.questions ? { questions: pending.questions } : {}),
        ...(opts.answers ? { answers: opts.answers } : {}),
      };
      return this.structuredManager.answerPermission(terminalId, requestId || pending.requestId, { behavior: 'allow', updatedInput });
    }
    return this.structuredManager.answerPermission(terminalId, requestId || pending.requestId, { behavior: 'deny', message: opts.message || 'Denied' });
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
    let config: Record<string, any> = {};
    try { config = JSON.parse(terminal.config || '{}'); } catch { /* default {} */ }
    config.autonomy = mode;
    terminalsDb.updateConfig(this.db, terminalId, config);
    this.structuredManager?.setEscalate(terminalId, mode !== 'autonomous');
    return true;
  }

  /** Gracefully interrupt a structured thread's current turn (does NOT kill it). */
  interrupt(terminalId: string): boolean {
    return this.structuredManager?.interrupt(terminalId) ?? false;
  }

  /**
   * Find-or-create the project's Overseer coordinator: a structured claude-code
   * thread tagged `config.role === 'coordinator'`. Returns the existing one if a
   * non-archived coordinator already exists, else spawns a new one labelled
   * "Overseer" via the normal createTerminal path. Idempotent (one per project).
   */
  ensureCoordinator(sessionId: string): terminalsDb.Terminal {
    const session = sessionsDb.getById(this.db, sessionId);
    if (!session) throw new Error('Session not found');

    const existing = terminalsDb.listBySession(this.db, sessionId)
      .map(terminalsDb.rowToTerminal)
      .find((t) => t.type === 'claude-code' && t.config?.role === 'coordinator');
    if (existing) {
      // A coordinator record can outlive its process (daemon restart). Revive it so
      // the caller gets a LIVE coordinator (resume if a session was captured, else fresh)
      // instead of a dead one that silently swallows directives.
      this.ensureStructuredAlive(existing.id);
      return existing;
    }

    return this.createTerminal(
      sessionId,
      'claude-code',
      'Overseer',
      undefined,
      undefined,
      undefined,
      { transport: 'structured', role: 'coordinator' },
    );
  }

  writeToTerminal(terminalId: string, data: string): void {
    this.ptyManager.write(terminalId, data);
  }

  resolveTerminalFilePath(terminalId: string, requestedPath: string): string | null {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return null;

    const session = sessionsDb.getById(this.db, terminal.session_id);
    if (!session) return null;

    const sessionRoot = path.resolve(session.working_dir);
    const terminalRoot = path.resolve(terminal.working_dir || session.working_dir);
    const roots = Array.from(new Set([terminalRoot, sessionRoot]));

    if (path.isAbsolute(requestedPath)) {
      const resolved = path.resolve(requestedPath);
      if (roots.some(root => this.isPathInside(root, resolved))) return resolved;
      throw new Error('Path traversal not allowed');
    }

    const sessionResolved = path.resolve(sessionRoot, requestedPath);
    if (!this.isPathInside(sessionRoot, sessionResolved)) {
      throw new Error('Path traversal not allowed');
    }

    if (requestedPath === '.dispatch/inbox' || requestedPath.startsWith('.dispatch/inbox/')) {
      return sessionResolved;
    }

    if (this.pathExists(sessionResolved)) {
      return sessionResolved;
    }

    const terminalResolved = path.resolve(terminalRoot, requestedPath);
    if (!this.isPathInside(terminalRoot, terminalResolved)) {
      throw new Error('Path traversal not allowed');
    }
    return terminalResolved;
  }

  private pathExists(resolvedPath: string): boolean {
    try {
      return fs.existsSync(resolvedPath);
    } catch {
      return false;
    }
  }

  sendFileReference(terminalId: string, requestedPath: string, mode: 'agent-context' | 'shell-path' = 'agent-context'): { sentText: string } | null {
    const absolutePath = this.resolveTerminalFilePath(terminalId, requestedPath);
    if (!absolutePath) return null;
    if (!this.ptyManager.isAlive(terminalId)) throw new Error('Terminal process is not running');

    const sentText = mode === 'shell-path'
      ? `${this.shellEscapePath(absolutePath)} `
      : `Use this file as context: ${absolutePath}\r`;
    this.ptyManager.write(terminalId, sentText);
    return { sentText };
  }

  stopAllTerminals(): void {
    this.ptyManager.killAll();
  }

  renameTerminal(terminalId: string, label: string): terminalsDb.Terminal | null {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return null;
    terminalsDb.updateLabel(this.db, terminalId, label);
    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  removeTerminal(terminalId: string): void {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return;
    // Only kill PTY for terminal types that have processes
    if (terminalsDb.isPtyType(terminal.type)) {
      if (this.ptyManager.isAlive(terminalId)) this.ptyManager.kill(terminalId);
      this.structuredManager?.kill(terminalId);
    }
    // Soft-delete: archive instead of remove
    terminalsDb.archive(this.db, terminalId);
  }

  // Restore an archived terminal
  restoreTerminal(terminalId: string): terminalsDb.Terminal | null {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return null;
    terminalsDb.unarchive(this.db, terminalId);
    // Re-spawn if it's a PTY type
    if (terminalsDb.isPtyType(terminal.type)) {
      try {
        this.spawnTerminal(terminalId);
      } catch {
        terminalsDb.updatePid(this.db, terminalId, null);
        terminalsDb.updateStatus(this.db, terminalId, 'error');
      }
    }
    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }

  listArchivedTerminals(sessionId: string): terminalsDb.Terminal[] {
    return terminalsDb.listArchivedBySession(this.db, sessionId).map(terminalsDb.rowToTerminal);
  }

  private spawnTerminal(terminalId: string): void {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) throw new Error('Terminal not found');

    const session = sessionsDb.getById(this.db, terminal.session_id);
    if (!session) throw new Error('Session not found');

    const workDir = terminal.working_dir || session.working_dir;

    // Runner terminals (agent runs) persist their prompt in config and always
    // launch the headless autonomous command — never resume/interactive.
    let config: Record<string, any> = {};
    try { config = JSON.parse(terminal.config || '{}'); } catch { /* default {} */ }
    const runnerPrompt: string | undefined =
      config.runner && typeof config.runnerPrompt === 'string' ? config.runnerPrompt : undefined;

    let command: string;
    let args: string[];

    if (terminal.type === 'shell') {
      const shell = platform.defaultShell();
      command = shell.command;
      args = shell.args;
    } else {
      const provider = getProvider(terminal.type);
      const specs: McpServerSpec[] = [];
      const prompts: string[] = [];
      const sec = this.secretsServerSpec?.();
      if (sec?.spec) { specs.push(sec.spec); if (sec.prompt) prompts.push(sec.prompt); }
      const intgSpecs = this.integrationsSpecs?.() ?? [];
      specs.push(...intgSpecs);
      const developerNote = this.toolsAwareness?.() ?? null;
      const secretsMcp = composeInjection(specs, { configPath: this.mcpConfigPath, prompts, developerNote });
      if (config.transport === 'structured' && terminal.type === 'claude-code' && this.structuredManager) {
        // Spawn (or, when an external_id is already known, RESUME) the structured
        // stream-json thread. spawnStructured re-applies the full role/escalate/MCP
        // wiring and backfills prior history on resume.
        this.spawnStructured(terminal, config, workDir);
        return; // structured path complete — skip PTY spawn + session-id capture
      }
      let cmd: { command: string; args: string[] };
      if (runnerPrompt !== undefined) {
        // Runner launches emit their own structured stream-json; no hooks needed.
        cmd = provider.buildRunnerCommand({ workDir, prompt: runnerPrompt, secretsMcp });
      } else {
        const statusHooks = this.buildStatusHooks(terminalId, terminal.type);
        const branchFrom: string | undefined = typeof config.branchFrom === 'string' ? config.branchFrom : undefined;
        cmd = terminal.external_id
          ? provider.buildResumeCommand({ externalSessionId: terminal.external_id, workDir, secretsMcp, statusHooks })
          : (branchFrom && provider.buildBranchCommand)
            ? provider.buildBranchCommand({ sourceSessionId: branchFrom, workDir, secretsMcp, statusHooks })
            : provider.buildNewCommand({ workDir, secretsMcp, statusHooks });
      }
      command = cmd.command;
      args = cmd.args;
    }

    const pid = this.ptyManager.spawn(terminalId, command, args, workDir);
    terminalsDb.updatePid(this.db, terminalId, pid);

    // If this was a fresh spawn (no external_id yet), let the provider try to
    // discover the session id it assigned — so a later relaunch can resume.
    if (terminal.type !== 'shell' && !terminal.external_id) {
      void this.captureExternalSessionId(terminalId, terminal.type, workDir);
    }
  }

  /**
   * Spawn — or, when a claude session id is already known, RESUME — a structured
   * stream-json thread, re-applying the SAME role / escalate / MCP wiring as the
   * original spawn:
   *   - coordinators get the Dispatch agency MCP folded in (autonomous spawn/steer),
   *   - the Overseer persona is injected via --append-system-prompt,
   *   - only typed AGENT threads escalate gated tools (the membrane).
   * When `terminal.external_id` is set it appends `-r <id>` (resume the same claude
   * conversation) and backfills the ring with prior history so the View isn't blank
   * after a daemon restart. Idempotent: a no-op when the thread is already alive.
   */
  private spawnStructured(terminal: terminalsDb.TerminalRow, config: Record<string, any>, workDir: string): void {
    if (!this.structuredManager) throw new Error('structured transport not supported for this provider');
    if (this.structuredManager.isAlive(terminal.id)) return; // already running — don't double-spawn

    const provider = getProvider(terminal.type);
    // Same secrets/integrations/tools-awareness MCP wiring as a fresh PTY spawn.
    const specs: McpServerSpec[] = [];
    const prompts: string[] = [];
    const sec = this.secretsServerSpec?.();
    if (sec?.spec) { specs.push(sec.spec); if (sec.prompt) prompts.push(sec.prompt); }
    const intgSpecs = this.integrationsSpecs?.() ?? [];
    specs.push(...intgSpecs);
    const developerNote = this.toolsAwareness?.() ?? null;
    const secretsMcp = composeInjection(specs, { configPath: this.mcpConfigPath, prompts, developerNote });
    const structuredMcp = config.role === 'coordinator'
      ? this.withAgencyMcp(secretsMcp, terminal.id, terminal.session_id)
      : secretsMcp;

    const resumeSessionId = terminal.external_id || undefined;

    let sc: { command: string; args: string[] };
    if (this.structuredCommandOverride) {
      // Test seam: spawn the fake instead of real claude. Still surface `-r <id>` on
      // resume so the resume path is observable in tests.
      sc = { command: this.structuredCommandOverride.command, args: [...this.structuredCommandOverride.args] };
      if (resumeSessionId) sc.args.push('-r', resumeSessionId);
    } else {
      const built = provider.buildStructuredCommand?.({ workDir, secretsMcp: structuredMcp, appendSystemPrompt: systemPromptFor(config), resumeSessionId });
      if (!built) throw new Error('structured transport not supported for this provider');
      sc = built;
    }

    // On resume, restore prior conversation from the claude transcript JSONL.
    const seedEvents = resumeSessionId ? readSessionBackfill(workDir, resumeSessionId) : undefined;

    // Autonomy dial: agents run AUTONOMOUSLY by default — they auto-allow every tool and
    // never prompt the human; the only thing that pauses an agent is an AskUserQuestion,
    // which the manager always surfaces and the service routes UP to the coordinator. Only
    // an explicit config.autonomy === 'supervised' re-arms the per-tool membrane (rare opt-in,
    // surfaces plain gated tools to the human). Persisted in config.autonomy so it survives a
    // resume after a daemon restart.
    const escalate = config.role === 'agent' && config.autonomy === 'supervised';

    const pid = this.structuredManager.spawn(terminal.id, {
      command: sc.command,
      args: sc.args,
      workDir,
      escalate,
      seedEvents,
    });
    terminalsDb.updatePid(this.db, terminal.id, pid);
  }

  /**
   * Lazily revive a structured thread on demand (its ws connects or it receives a
   * message) after a daemon restart: if it's not alive but is a non-archived
   * structured claude-code thread, re-spawn it — resuming the same claude
   * conversation when an external_id was captured, else spawning fresh. Idempotent —
   * returns true if alive (or already was), false only for non-structured/archived
   * threads. Never throws.
   */
  ensureStructuredAlive(terminalId: string): boolean {
    if (!this.structuredManager) return false;
    if (this.structuredManager.isAlive(terminalId)) return true;
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal || terminal.type !== 'claude-code' || terminal.archived_at) return false;
    let config: Record<string, any> = {};
    try { config = JSON.parse(terminal.config || '{}'); } catch { /* default {} */ }
    if (config.transport !== 'structured') return false;
    // No external_id ⇒ spawn FRESH. A structured thread that never captured a claude
    // session id (created-but-not-yet-run, or a coordinator whose process the restart
    // killed before init) must still come back to life rather than silently swallow
    // messages. With an external_id, spawnStructured resumes the same conversation.
    const session = sessionsDb.getById(this.db, terminal.session_id);
    if (!session) return false;
    const workDir = terminal.working_dir || session.working_dir;
    try {
      this.spawnStructured(terminal, config, workDir);
      return this.structuredManager.isAlive(terminalId);
    } catch {
      return false;
    }
  }

  /**
   * Fold the Dispatch "agency" MCP server into a coordinator's --mcp-config so it
   * can autonomously spawn + steer typed agents. Reads any existing combined config
   * (Doppler / integrations), adds a `dispatch` server pointing at the compiled
   * agency-mcp.js, and writes a coordinator-specific config file (never clobbering
   * the shared mcp.json). DISPATCH_SESSION = this project's session, so the agent
   * threads the coordinator spawns land in the same project. Best-effort: on any IO
   * error, falls back to the un-augmented config so the coordinator still launches.
   */
  private withAgencyMcp(secretsMcp: SecretsMcpInjection, terminalId: string, sessionId: string): SecretsMcpInjection {
    try {
      let mcpServers: Record<string, unknown> = {};
      if (secretsMcp.claudeConfigPath) {
        try {
          const existing = JSON.parse(fs.readFileSync(secretsMcp.claudeConfigPath, 'utf8'));
          if (existing && typeof existing.mcpServers === 'object' && existing.mcpServers) mcpServers = existing.mcpServers;
        } catch { /* unreadable → start fresh */ }
      }
      const agencyPath = fileURLToPath(new URL('../overseer/agency-mcp.js', import.meta.url));
      mcpServers.dispatch = {
        command: 'node',
        args: [agencyPath],
        env: {
          DISPATCH_SESSION: sessionId,
          DISPATCH_PORT: String(process.env.PORT || 3456),
        },
      };
      const coordPath = path.join(path.dirname(this.mcpConfigPath), `coordinator-${terminalId}.mcp.json`);
      fs.mkdirSync(path.dirname(coordPath), { recursive: true });
      fs.writeFileSync(coordPath, JSON.stringify({ mcpServers }, null, 2));
      return { ...secretsMcp, claudeConfigPath: coordPath };
    } catch {
      return secretsMcp;
    }
  }

  private async captureExternalSessionId(terminalId: string, type: string, workDir: string): Promise<void> {
    const provider = getProvider(type);
    if (!provider.captureSessionId) return;
    const spawnTime = Date.now();
    try {
      const sid = await provider.captureSessionId({ workDir, spawnTime, deadlineMs: 30_000 });
      if (!sid) return;
      const current = terminalsDb.getById(this.db, terminalId);
      if (!current || current.external_id) return;
      terminalsDb.updateExternalId(this.db, terminalId, sid);
    } catch {
      // Best-effort; relaunch will simply start a fresh session if we miss it.
    }
  }

  private isPathInside(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private shellEscapePath(absolutePath: string): string {
    return `'${absolutePath.replace(/'/g, `'\\''`)}'`;
  }

  private defaultTerminalLabel(sessionId: string, type: TerminalType): string {
    const terminals = terminalsDb.listBySession(this.db, sessionId);
    const sameType = terminals.filter(t => t.type === type);

    switch (type) {
      case 'claude-code': return sameType.length > 0 ? `Claude Code #${sameType.length + 1}` : 'Claude Code';
      case 'codex': return sameType.length > 0 ? `Codex #${sameType.length + 1}` : 'Codex';
      case 'shell': return sameType.length > 0 ? `Terminal #${sameType.length + 1}` : 'Terminal';
    }
  }

  private autoName(workDir: string): string {
    const folder = workDir.split('/').pop() || 'session';
    const existing = sessionsDb.list(this.db).filter(s => s.name.startsWith(folder));
    return existing.length > 0 ? `${folder} #${existing.length + 1}` : folder;
  }

}

/** A short single-line snippet centered on a match, with ellipses + collapsed whitespace. */
function snippetAround(text: string, at: number, matchLen: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  // Recompute the match position in the collapsed string (approximate is fine).
  const idx = flat.toLowerCase().indexOf(text.slice(at, at + matchLen).replace(/\s+/g, ' ').trim().toLowerCase());
  const start = Math.max(0, (idx < 0 ? 0 : idx) - 30);
  const end = Math.min(flat.length, (idx < 0 ? 0 : idx) + matchLen + 50);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}
