import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { PTYManager } from '../pty/manager.js';
import { hasControlChars } from './pty-message.js';

/** What ThreadFiles needs. Every field is required. */
export interface ThreadFilesDeps {
  db: Database.Database;
  /** The CLI processes: a file reference is typed into one. */
  pty: Pick<PTYManager, 'isAlive' | 'write'>;
}

/**
 * The files of a thread (W3-B: moved out of SessionService): where a path that a thread names is
 * on disk (the project folder, the thread's own folder, the inbox), and a file reference typed
 * into the CLI of a thread.
 */
export class ThreadFiles {
  constructor(private readonly deps: ThreadFilesDeps) {}

  // The inputs under the names the moved code uses.
  private get db(): Database.Database { return this.deps.db; }
  private get ptyManager(): Pick<PTYManager, 'isAlive' | 'write'> { return this.deps.pty; }

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
    // A path with a CR, ESC or other control character would be typed as keystrokes (quoting a path
    // for a shell does not neutralize terminal control bytes), in both modes.
    if (hasControlChars(absolutePath)) return null;

    const sentText = mode === 'shell-path'
      ? `${this.shellEscapePath(absolutePath)} `
      : `Use this file as context: ${absolutePath}\r`;
    this.ptyManager.write(terminalId, sentText);
    return { sentText };
  }

  private isPathInside(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private shellEscapePath(absolutePath: string): string {
    return `'${absolutePath.replace(/'/g, `'\\''`)}'`;
  }
}
