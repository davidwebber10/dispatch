import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import * as coordinatorMessagesDb from '../db/coordinator-messages.js';
import { PTYManager } from '../pty/manager.js';
import { redactKeys } from '../auth/redact-keys.js';
import { senderLine } from '../auth/key-rules.js';
import { ptyMessagePayload, flattenForPty } from './pty-message.js';
import type { ThreadSpawner } from './thread-spawner.js';
import type { ContentBlock, IStructuredManager, MessageSource } from '../structured/manager.js';

/** What ThreadMessages needs. Every field is required. */
export interface ThreadMessagesDeps {
  db: Database.Database;
  /** The CLI processes: a message to a CLI thread is typed into one. */
  pty: Pick<PTYManager, 'isAlive' | 'write'>;
  /** The service's clock (the time of a log row). */
  clock: () => number;
  /** Why the last start of a structured thread failed. */
  spawner: Pick<ThreadSpawner, 'lastSpawnError'>;
  /** The thread operations that a send uses. SessionService gives its own methods, so a caller that replaces one is reached. */
  threads: {
    structuredManagerForTerminal(terminalId: string): IStructuredManager | undefined;
    ensureStructuredAlive(terminalId: string): boolean;
    isStructuredTerminal(terminal: terminalsDb.TerminalRow): boolean;
    sendStructuredMessage(terminalId: string, content: string | ContentBlock[], source?: MessageSource, logAs?: coordinatorMessagesDb.CoordinatorMessageSource): void;
    /** Anyone else sending to a thread, or the owner typing in it, ends its usage-limit pause. */
    noteThreadTouched(terminalId: string, source?: string, logAs?: string): void;
  };
}

/**
 * The messages to a thread (W3-B: moved out of SessionService): the send to a structured thread
 * (it starts a dead one first), the send to a thread on either transport (a CLI thread gets the text
 * typed into its terminal), and the overseer message log of every message that reaches a coordinator.
 */
export class ThreadMessages {
  constructor(private readonly deps: ThreadMessagesDeps) {}

  // The inputs under the names the moved code uses.
  private get db(): Database.Database { return this.deps.db; }
  private get ptyManager(): Pick<PTYManager, 'isAlive' | 'write'> { return this.deps.pty; }
  private get spawner(): Pick<ThreadSpawner, 'lastSpawnError'> { return this.deps.spawner; }
  private clock(): number { return this.deps.clock(); }
  private structuredManagerForTerminal(terminalId: string): IStructuredManager | undefined { return this.deps.threads.structuredManagerForTerminal(terminalId); }
  private ensureStructuredAlive(terminalId: string): boolean { return this.deps.threads.ensureStructuredAlive(terminalId); }
  private isStructuredTerminal(terminal: terminalsDb.TerminalRow): boolean { return this.deps.threads.isStructuredTerminal(terminal); }
  private noteThreadTouched(terminalId: string, source?: string, logAs?: string): void { this.deps.threads.noteThreadTouched(terminalId, source, logAs); }

  sendStructuredMessage(
    terminalId: string,
    content: string | ContentBlock[],
    source?: MessageSource,
    logAs?: coordinatorMessagesDb.CoordinatorMessageSource,
  ): void {
    this.noteThreadTouched(terminalId, source, logAs);
    // Lazily resume a thread that died on a daemon restart (resumes the same claude
    // conversation when an external_id was captured) before delivering the message.
    const manager = this.structuredManagerForTerminal(terminalId);
    if (!manager?.isAlive(terminalId)) this.ensureStructuredAlive(terminalId);
    if (!manager?.isAlive(terminalId)) {
      const cause = this.spawner.lastSpawnError.get(terminalId);
      throw new Error(cause ? `could not start the thread: ${cause}` : 'no structured session for terminal');
    }
    manager.sendMessage(terminalId, content, source);
    this.logCoordinatorMessage(terminalId, content, logAs ?? (source === 'user' ? 'user' : source === 'coordinator' ? 'coordinator' : 'daemon'));
  }

  /**
   * The overseer message log (structured-recap spec, Unit 1): every message that reaches a
   * coordinator, with who sent it, so a ledger quote can be checked against the human's real
   * words. Only coordinators are logged. Written AFTER manager.sendMessage returns; a failed
   * write is logged and never blocks the send.
   */
  logCoordinatorMessage(
    terminalId: string,
    content: string | ContentBlock[],
    source: coordinatorMessagesDb.CoordinatorMessageSource,
  ): void {
    try {
      const row = terminalsDb.getById(this.db, terminalId);
      if (!row) return;
      let cfg: Record<string, any> = {};
      try { cfg = JSON.parse(row.config || '{}'); } catch { /* default {} */ }
      if (cfg.role !== 'coordinator') return;
      coordinatorMessagesDb.append(this.db, {
        terminalId,
        source,
        text: redactKeys(coordinatorMessagesDb.messageText(content)),
        sentAt: new Date(this.clock()).toISOString(),
      });
    } catch (err) {
      console.error(`coordinator message log: write failed for ${terminalId}`, err);
    }
  }

  /**
   * Deliver a message to a thread on EITHER transport — the transport-agnostic entry point
   * behind POST /terminals/:id/message (and so behind the dispatch MCP's message_thread).
   *
   * Previously that route called sendStructuredMessage directly, which throws
   * "no structured session for terminal" for a PTY thread — so one thread could only ever
   * message a peer that happened to be in Pretty mode. A PTY thread has no message channel,
   * but it does have a TUI we can type into (exactly what sendFileReference already does), so
   * route it there instead of failing. Returns which transport delivered it, plus whether any
   * non-text blocks had to be dropped, so the caller can be honest with the sender.
   */
  sendThreadMessage(
    terminalId: string,
    content: string | ContentBlock[],
    source?: MessageSource,
    logAs?: coordinatorMessagesDb.CoordinatorMessageSource,
    fromProject?: import('../auth/key-rules.js').SenderFacts,
  ): { transport: 'structured' | 'pty'; droppedNonText: boolean; delivered?: string | ContentBlock[] } {
    // A cross-project message from a thread of another project (owner decisions PK-4 and PK-5): the daemon
    // puts one line before the text so the receiver, and the owner who reads the thread, see where it came from.
    if (fromProject) {
      const line = senderLine(fromProject);
      content = typeof content === 'string' ? `${line}\n\n${content}` : [{ type: 'text', text: line }, ...content];
    }
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) throw new Error('Thread not found');
    // A shell tab has no agent to read a message: text typed into it RUNS AS A COMMAND, with the
    // daemon user's full rights and outside any coordinator's sandbox. message_thread,
    // message_agent, and spawn_agent all arrive here, so refuse it for every caller.
    if (terminal.type === 'shell') {
      throw new Error('cannot message a shell tab: it has no agent, so the text would run as a command');
    }

    if (this.isStructuredTerminal(terminal)) {
      this.deps.threads.sendStructuredMessage(terminalId, content, source, logAs);
      return { transport: 'structured', droppedNonText: false, delivered: content };
    }
    this.noteThreadTouched(terminalId, source, logAs);

    // PTY: type the message into the CLI's own input box and submit it.
    const { text, droppedNonText } = flattenForPty(content as string | { type?: string; text?: string }[]);
    if (!text) {
      throw new Error(
        droppedNonText
          ? 'cannot deliver this message to a CLI thread: it has no text (images can only be sent to a Pretty thread)'
          : 'text is required',
      );
    }
    // Deliberately NOT auto-relaunched the way a structured thread is: restarting a PTY would
    // discard the live terminal the human may be reading. Fail loudly instead.
    if (!this.ptyManager.isAlive(terminalId)) throw new Error('thread process is not running');
    this.ptyManager.write(terminalId, ptyMessagePayload(text));
    return { transport: 'pty', droppedNonText, delivered: text };
  }
}
