/**
 * One Endless Chat turn (spec 2026-10-13 section 5; the gist section 6):
 *   wait (bounded) until every earlier message is summarized → render the view → log the
 *   message → spawn a fresh `claude -p --model opus` in the fixed folder → send
 *   [view][status][message] → log each reply, tool call and result as it arrives.
 * Messages sent while a turn runs reach the process between tool calls. Thinking is
 * streamed to the UI and never logged. Nothing carries over between turns but the log.
 */
import type { ContentBlock, IStructuredManager, PendingPermission } from '../structured/manager.js';
import type { EndlessMessage, EndlessStore } from './store.js';
import type { ViewKeeper } from './view-keeper.js';
import type { Compactor } from './compactor.js';
import type { LogInput } from './log.js';
import type { ZoomImage } from './recall.js';
import { endlessClaudeArgs, FIXED_CONTEXT_ENV, TURN_MODEL } from './claude-args.js';
import { clipToolOutput, messageLine } from './text.js';
import { usageOf, type Usage } from './summarizer.js';

export const TURN_WAIT_MS = 30_000;
/** After a `result`, wait this long for more events (a queued message starts a second turn). */
export const RESULT_GRACE_MS = 1_500;

export interface UserInput { text: string; project: string | null; media: string[] }
export type TurnStatus = 'idle' | 'waiting' | 'running' | 'failed' | 'interrupted';
export type EndlessEvent =
  | { type: 'endless:delta'; kind: 'text' | 'thinking'; text: string }
  | { type: 'endless:turn'; status: TurnStatus; error?: string };

export interface TurnDeps {
  store: EndlessStore;
  views: ViewKeeper;
  compactor: Compactor;
  manager: IStructuredManager;
  chatDir: string;
  mcpConfigPath: string;
  systemPrompt: () => string;
  statusBlock: (project: string | null) => string;
  projectName: (id: string | null) => string | null;
  log: (input: LogInput) => EndlessMessage[];
  emit: (e: EndlessEvent) => void;
  readImage: (file: string) => ZoomImage | null;
  onUsage?: (u: Usage) => void;
  waitMs?: number;
  graceMs?: number;
  command?: string;
  commandArgs?: string[];
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => (b?.type === 'text' ? String(b.text ?? '') : b?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

export class TurnRunner {
  private state: 'idle' | 'waiting' | 'running' = 'idle';
  private queued: UserInput[] = [];
  private turnId: string | null = null;
  private turnProject: string | null = null;
  private n = 0;
  private done: Promise<void> | null = null;

  constructor(private readonly d: TurnDeps) {}

  get status(): 'idle' | 'waiting' | 'running' { return this.state; }

  whenIdle(): Promise<void> { return this.done ?? Promise.resolve(); }

  send(input: UserInput): void {
    if (this.state === 'running' && this.turnId) { this.handOff(input); return; }
    if (this.state === 'waiting') { this.queued.push(input); return; }
    this.start(input, true);
  }

  /** Run the last user message again (it is already logged; it is not logged twice). */
  retry(): boolean {
    if (this.state !== 'idle') return false;
    const run = this.d.store.lastUserRun();
    if (!run.length) return false;
    this.start({ text: run.map((m) => m.text).join(''), project: run[0].project, media: run.flatMap((m) => m.media) }, false);
    return true;
  }

  private start(input: UserInput, logIt: boolean): void {
    this.state = 'waiting';
    this.turnProject = input.project;
    this.d.emit({ type: 'endless:turn', status: 'waiting' });
    this.done = this.run(input, logIt).finally(() => { this.done = null; });
  }

  private content(input: UserInput, before: string[]): ContentBlock[] {
    const blocks: ContentBlock[] = before.map((text) => ({ type: 'text', text }));
    blocks.push({ type: 'text', text: messageLine('user', input.text, this.d.projectName(input.project)) });
    for (const file of input.media) {
      const img = this.d.readImage(file);
      if (img) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } });
    }
    return blocks;
  }

  private handOff(input: UserInput): void {
    this.d.log({ kind: 'user', text: input.text, project: input.project, media: input.media });
    this.d.manager.sendMessage(this.turnId!, this.content(input, []));
  }

  private async run(first: UserInput, logIt: boolean): Promise<void> {
    const d = this.d;
    let error: string | undefined;
    try {
      await d.compactor.waitForSettled(d.store.count(), d.waitMs ?? TURN_WAIT_MS);
      const view = d.views.turnBlocks();             // render the view first …
      const status = d.statusBlock(first.project);
      if (logIt) d.log({ kind: 'user', text: first.text, project: first.project, media: first.media }); // … then log
      const id = `endless-turn-${++this.n}-${Date.now()}`;
      this.turnId = id;
      const ended = this.watch(id);
      d.manager.spawn(id, {
        command: d.command ?? 'claude',
        args: [...(d.commandArgs ?? []), ...endlessClaudeArgs({ model: TURN_MODEL, systemPrompt: d.systemPrompt(), mcpConfigPath: d.mcpConfigPath, userTools: true })],
        workDir: d.chatDir,
        env: FIXED_CONTEXT_ENV,
      });
      this.state = 'running';
      d.emit({ type: 'endless:turn', status: 'running' });
      d.manager.sendMessage(id, this.content(first, [...view, status]));
      for (const q of this.queued.splice(0)) this.handOff(q);
      error = (await ended).error;
      if (d.manager.isAlive(id)) d.manager.kill(id);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      for (const q of this.queued.splice(0)) d.log({ kind: 'user', text: q.text, project: q.project, media: q.media });
      this.turnId = null;
      this.state = 'idle';
      d.emit(error ? { type: 'endless:turn', status: 'failed', error } : { type: 'endless:turn', status: 'idle' });
    }
  }

  private watch(id: string): Promise<{ error?: string }> {
    const d = this.d;
    const m = d.manager;
    return new Promise((resolve) => {
      let grace: NodeJS.Timeout | null = null;
      let sawResult = false;
      let failure: string | undefined;
      const finish = (error?: string) => {
        if (grace) clearTimeout(grace);
        m.off('event', onEvent);
        m.off('exit', onExit);
        m.off('failed', onFailed);
        m.off('permission', onPermission);
        resolve({ error });
      };
      const onEvent = (tid: string, ev: any) => {
        if (tid !== id) return;
        if (grace) { clearTimeout(grace); grace = null; }
        this.record(ev);
        if (ev?.type === 'result') {
          sawResult = true;
          failure = ev.is_error ? String(ev.result || ev.subtype || 'the turn failed') : undefined;
          const u = usageOf(ev.usage);
          if (u) d.onUsage?.(u);
          grace = setTimeout(() => finish(failure), d.graceMs ?? RESULT_GRACE_MS);
        }
      };
      const onExit = (tid: string, code: number) => {
        if (tid === id) finish(sawResult ? failure : `the turn process exited (code ${code}) before it finished`);
      };
      const onFailed = (tid: string) => { if (tid === id && !sawResult) finish('the turn process failed'); };
      const onPermission = (tid: string, p: PendingPermission) => {
        if (tid === id) m.answerPermission(id, p.requestId, { behavior: 'deny', message: 'Ask the user in your reply instead, then end your turn.' });
      };
      m.on('event', onEvent);
      m.on('exit', onExit);
      m.on('failed', onFailed);
      m.on('permission', onPermission);
    });
  }

  private record(ev: any): void {
    const d = this.d;
    if (ev?.parent_tool_use_id != null) return; // a sub-agent's own steps stay out of the log
    const project = this.turnProject;
    if (ev?.type === 'stream_event') {
      const delta = ev.event?.type === 'content_block_delta' ? ev.event.delta : null;
      if (delta?.type === 'text_delta' && delta.text) d.emit({ type: 'endless:delta', kind: 'text', text: delta.text });
      if (delta?.type === 'thinking_delta' && delta.thinking) d.emit({ type: 'endless:delta', kind: 'thinking', text: delta.thinking });
      return;
    }
    if (ev?.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        if (b?.type === 'text' && String(b.text ?? '').trim()) d.log({ kind: 'unii', text: b.text, project });
        else if (b?.type === 'tool_use') d.log({ kind: 'tool', text: `${b.name} ${JSON.stringify(b.input ?? {})}`, project });
        // thinking blocks: streamed above, never logged
      }
      return;
    }
    if (ev?.type === 'user' && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        if (b?.type === 'tool_result') d.log({ kind: 'echo', text: clipToolOutput(toolResultText(b.content)), project });
      }
    }
  }
}
