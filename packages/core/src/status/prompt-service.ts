import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import type { PTYManager } from '../pty/manager.js';
import type { EventBroadcaster } from '../ws/events.js';
import { renderScreen } from './screen.js';
import { detectPrompt, type DetectedPrompt } from './prompt.js';

/**
 * Detects interactive prompts on a terminal's live screen and broadcasts
 * `terminal:prompt` (or null when it clears). Renders the PTY buffer through a
 * headless terminal, parses it, and dedupes so an unchanged prompt isn't re-sent.
 * State is only the signature of the last-broadcast prompt per terminal.
 */
export class PromptService {
  private active = new Map<string, string>();

  constructor(
    private db: Database.Database,
    private ptyManager: PTYManager,
    private broadcaster: EventBroadcaster,
  ) {}

  async check(terminalId: string): Promise<void> {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return;
    const screen = await renderScreen(this.ptyManager.getBuffer(terminalId));
    const prompt = detectPrompt(terminal.type, screen);
    const sig = prompt ? `${prompt.kind}::${prompt.question}::${prompt.parsed}` : '';
    const prev = this.active.get(terminalId) ?? '';
    if (sig === prev) return; // unchanged (incl. still-no-prompt)
    if (prompt) this.active.set(terminalId, sig);
    else this.active.delete(terminalId);
    this.broadcaster.broadcast({ type: 'terminal:prompt', terminalId, prompt });
  }

  /** On terminal exit/removal: clear any active prompt. */
  clear(terminalId: string): void {
    if (!this.active.has(terminalId)) return;
    this.active.delete(terminalId);
    this.broadcaster.broadcast({ type: 'terminal:prompt', terminalId, prompt: null });
  }
}

export type { DetectedPrompt };
