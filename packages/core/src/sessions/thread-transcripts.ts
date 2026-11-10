import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { parseClaudeTranscript, type ConvItem } from '../conversation/transcript.js';
import { parseCodexRollout } from '../conversation/codex-transcript.js';
import { ConversationReader, type ConvPage, type ConvPageOptions, type SearchMatch, type TranscriptLocation } from '../conversation/reader.js';
import { findCodexRolloutPath } from './codex-sessions.js';
import { platform } from '../platform/index.js';
import { resolveTranscriptPath } from './transcript-path.js';
import { threadHarnessCapabilities } from './harness-capabilities.js';

/**
 * The one-file recovery decision, pure for testability: adopt the project dir's single
 * transcript ONLY when it could plausibly belong to this terminal — i.e. it was born at or
 * after the terminal's creation (60s slack for clock skew). A transcript that predates the
 * terminal is someone else's session that happens to share the project dir (the user's own
 * `claude` runs) — adopting it made a coordinator resume the USER'S conversation (Control
 * Plane rendered their terminal history; their terminal resume showed coordinator turns).
 * 0 files = nothing to recover; 2+ = ambiguous (unchanged rule, see recoverSessionId).
 */
export function pickRecoverableSession(
  files: { id: string; birth: number }[],
  terminalCreatedAtMs: number,
): string | null {
  if (files.length !== 1) return null;
  return files[0].birth >= terminalCreatedAtMs - 60_000 ? files[0].id : null;
}

/**
 * Where a thread's transcript is, and the reads of it (W3-B: moved out of SessionService).
 * ConversationReader (W2-B) does the byte-range work; this class finds the file for a thread.
 */
export class ThreadTranscripts {
  constructor(private readonly db: Database.Database) {}

  /** Reads transcript pages by byte range, off the event loop's critical path (conversation/reader.ts). Made on first use. */
  private conversationReaderInstance: ConversationReader | null = null;
  private get conversationReader(): ConversationReader {
    return (this.conversationReaderInstance ??= new ConversationReader({ db: this.db, locate: (id) => this.locateTranscript(id) }));
  }

  /**
   * Read + parse a WINDOW of the live transcript for a terminal's session (View).
   * The transcript is addressed by complete-JSONL-line index:
   *   - default (initial load): the most recent `limit` lines.
   *   - `since`: lines after index `since` (polling for new messages at the bottom).
   *   - `before`: the `limit` lines ending just before index `before` (loading
   *     older history at the top, for reverse infinite scroll).
   *   - `beforeUuid`: like `before`, but the anchor is the transcript-line `uuid` of
   *     the OLDEST item a caller has already rendered (from a ws replay, which has no
   *     line index of its own — see ConvItem.uuid). Resolved to a line index here so
   *     the very first reverse-scroll page can fetch genuinely-older content instead
   *     of defaulting to the newest window, which would just overlap what's already
   *     on screen. Falls back to the newest-window default when the uuid isn't found
   *     (e.g. it hasn't reached disk yet, or predates this transcript file).
   * Returns the parsed `items`, `cursor` (= total line count, the bottom edge for
   * polling), `startLine` (top edge of the returned window), and `hasMore`
   * (whether older lines exist above the window). Claude Code only for now.
   */
  /**
   * True when this thread's history should come from its REST transcript rather than from a
   * ws replay of the ring. Only Codex qualifies, and the reason is identity, not format:
   * a Codex item carries no per-message uuid, so a REST page overlapping the ring replay
   * cannot be dedup'd (the client falls back to a content fingerprint, which the two
   * translators do not agree on for tool calls). Claude Code keeps replaying its ring —
   * its uuids make the overlap safe, and that path is the fast, well-covered one.
   * See ws/structured.ts's `restOwnsHistory` and getConversation's codex branch.
   */
  historyOwnedByRest(terminalId: string): boolean {
    return threadHarnessCapabilities(terminalsDb.getById(this.db, terminalId)?.type).restHistory;
  }

  /**
   * True when anything the ws replay's `tail=N` bound cuts is recoverable by paging the
   * REST transcript (getConversation). Grok is the odd one out: it has NO pageable
   * transcript (unsupported), so its threads must replay the full ring or the cut history
   * is simply gone from the UI. See ws/structured.ts's `restCanPageHistory`.
   */
  historyRestPageable(terminalId: string): boolean {
    return threadHarnessCapabilities(terminalsDb.getById(this.db, terminalId)?.type).restPageable;
  }

  /**
   * Where a thread's transcript file is, and the parser for one line of its format.
   * `null`: no transcript (yet). `'unsupported'`: the thread type never has one.
   */
  private locateTranscript(terminalId: string): TranscriptLocation | null | 'unsupported' {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return null;
    // Both agent types keep a durable transcript on disk, in their own format and their own
    // place. Anything else (a plain shell) has none, and says so rather than looking empty.
    if (terminal.type !== 'claude-code' && terminal.type !== 'codex') return 'unsupported';

    if (terminal.type === 'codex') {
      // Codex has no Claude project dir. It files rollouts by date under ~/.codex/sessions,
      // keyed by the session id we captured at spawn — there is no equivalent of
      // recoverSessionId, so a thread that never recorded one has no history to serve.
      const sessionId = terminal.external_id;
      if (!sessionId) return null;
      const file = findCodexRolloutPath(sessionId);
      // Per-line parser for whichever transcript format this thread writes. Both take one
      // line and return the items it contains, so the reader's windowing is format-agnostic.
      return file ? { file, parseLine: parseCodexRollout } : null;
    }

    const session = sessionsDb.getById(this.db, terminal.session_id);
    const workDir = terminal.working_dir || session?.working_dir;
    if (!workDir) return null;

    const dir = platform.claudeProjectDir(workDir);
    // external_id is normally captured at spawn; when it wasn't, recover it from the
    // project's transcript files so the thread still renders in View.
    const sessionId = terminal.external_id || this.recoverSessionId(terminalId, dir);
    if (!sessionId) return null;

    // Resolve rather than assume: a session that changed cwd (EnterWorktree) keeps its id
    // but relocates under a different project dir, and `workDir` here is whatever the thread
    // spawned with. Reading the computed path directly is what made those chats render
    // empty — see sessions/transcript-path.ts.
    const file = resolveTranscriptPath(workDir, sessionId);
    return file ? { file, parseLine: parseClaudeTranscript } : null;
  }

  /**
   * A window of the thread's transcript. A thin delegate: ConversationReader.page does the work
   * (a byte-range read, not a full read), so this returns a Promise.
   */
  getConversation(terminalId: string, opts: ConvPageOptions = {}): Promise<ConvPage> {
    return this.conversationReader.page(terminalId, opts);
  }

  /**
   * The items of the thread's newest `limit` transcript lines, synchronously, from a bounded
   * tail read. For the in-process callers that need the last assistant text inside a
   * synchronous path (agentOutputText, lastTurnTexts). Routes and tools use getConversation.
   */
  conversationTail(terminalId: string, limit: number): ConvItem[] {
    return this.conversationReader.tailItems(terminalId, limit);
  }

  /**
   * Full-history text search over a terminal's transcript. Returns matches with
   * their source line index (so View can load + scroll to that spot) and a short
   * snippet around the match. Newest matches first, capped for response size.
   * Claude Code only, as before. A thin delegate to ConversationReader.search.
   */
  async searchConversation(terminalId: string, query: string, limit = 200): Promise<{ matches: SearchMatch[] }> {
    if (!threadHarnessCapabilities(terminalsDb.getById(this.db, terminalId)?.type).transcriptSearch) return { matches: [] };
    return this.conversationReader.search(terminalId, query, limit);
  }

  /**
   * Recover a missing transcript link, but ONLY when it's unambiguous: if the project's
   * Claude transcript dir holds exactly one *.jsonl, adopt it as the terminal's external_id
   * (so resume + future loads work too). With 0 files there's nothing to recover; with 2+ we
   * cannot tell the terminal's own transcript from unrelated `claude` sessions that share the
   * project dir (the user's own terminal runs, other coordinators), so we return null rather
   * than guess "newest" — guessing rendered a conversation the terminal never owned (issue #7:
   * a coordinator with no external_id surfaced a stranger's session). A terminal that actually
   * ran captured its external_id at the structured `init` event (first-write-wins, see
   * setStructuredManager), so it never depends on this fallback; a never-run coordinator
   * correctly falls back to the empty greeting instead of an arbitrary transcript.
   * Even a single file is adopted only if it was born after this terminal was created (see pickRecoverableSession) — the sole transcript in a quiet dir is usually the USER'S own session, not this terminal's.
   */
  recoverSessionId(terminalId: string, dir: string): string | null {
    let files: { id: string; birth: number }[];
    try {
      files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const s = fs.statSync(path.join(dir, f));
          return { id: f.replace(/\.jsonl$/, ''), birth: s.birthtimeMs || s.ctimeMs };
        });
    } catch { return null; }
    const terminal = terminalsDb.getById(this.db, terminalId);
    const createdAtMs = terminal ? Date.parse(terminal.created_at) : NaN;
    if (!Number.isFinite(createdAtMs)) return null; // no terminal row → nothing to attribute to
    const id = pickRecoverableSession(files, createdAtMs);
    if (!id) return null;
    try { terminalsDb.updateExternalId(this.db, terminalId, id); } catch { /* best effort */ }
    return id;
  }
}
