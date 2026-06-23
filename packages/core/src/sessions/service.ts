import fs from 'fs';
import os from 'os';
import path from 'path';
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
import type { SecretsMcpInjection, StatusHooksInjection } from '../providers/types.js';
import { parseClaudeTranscript, type ConvItem } from '../conversation/transcript.js';

interface StatusContext {
  serverUrl: string;
  /** Directory where per-terminal Claude hook settings files are written. */
  hooksDir: string;
  /** Absolute path to the Codex notify helper script. */
  codexHelperPath: string;
}

export class SessionService {
  /** Supplies the Doppler MCP injection for spawned CLIs; set by the server wiring. */
  private secretsInjection: (() => SecretsMcpInjection) | null = null;
  /** How spawned CLIs phone home with lifecycle events; set by the server wiring. */
  private statusContext: StatusContext | null = null;

  constructor(
    private db: Database.Database,
    private ptyManager: PTYManager,
  ) {}

  setSecretsInjection(fn: () => SecretsMcpInjection): void {
    this.secretsInjection = fn;
  }

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
    }
    terminalsDb.removeBySession(this.db, id);

    if (this.ptyManager.isAlive(id)) this.ptyManager.kill(id);
    sessionsDb.archive(this.db, id);
  }

  // --- Terminal-level operations ---

  createTerminal(sessionId: string, type: TerminalType, label?: string, skipPermissions?: boolean, workingDir?: string, externalId?: string): terminalsDb.Terminal {
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

    const dir = path.join(os.homedir(), '.claude', 'projects', workDir.replace(/\//g, '-'));
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
    const dir = path.join(os.homedir(), '.claude', 'projects', workDir.replace(/\//g, '-'));
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
    terminalsDb.updatePid(this.db, terminalId, null);
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
      command = '/bin/zsh';
      args = [];
    } else {
      const provider = getProvider(terminal.type);
      const secretsMcp = this.secretsInjection?.() ?? undefined;
      let cmd: { command: string; args: string[] };
      if (runnerPrompt !== undefined) {
        // Runner launches emit their own structured stream-json; no hooks needed.
        cmd = provider.buildRunnerCommand({ workDir, prompt: runnerPrompt, secretsMcp });
      } else {
        const statusHooks = this.buildStatusHooks(terminalId, terminal.type);
        cmd = terminal.external_id
          ? provider.buildResumeCommand({ externalSessionId: terminal.external_id, workDir, secretsMcp, statusHooks })
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
