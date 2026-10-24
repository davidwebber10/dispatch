/**
 * Summarizer over `claude -p --model haiku`: one stream-json process per compaction, so the
 * "Too long" follow-up is a second user message in the same conversation. Compactions are
 * isolated from the user's tools (COMPACTION_ISOLATION_ARGS). Every permission request is
 * denied, but Claude Code can auto-approve a tool with no request, so any tool_use also
 * fails the call.
 */
import type { IStructuredManager } from '../structured/manager.js';
import type { Summarizer, SummarizerOpenOptions, SummarizerSession, Usage } from './summarizer.js';
import { usageOf } from './summarizer.js';
import type { KeyHandle, KeyRegistry } from '../auth/principals.js';
import { endlessClaudeArgs, COMPACTION_ENV, SUMMARY_EFFORT, SUMMARY_MODEL } from './claude-args.js';

export interface ClaudeSummarizerOptions {
  manager: IStructuredManager;
  chatDir: string;
  mcpConfigPath: string;
  model?: string;
  effort?: string;
  askTimeoutMs?: number;
  onUsage?: (u: Usage) => void;
  /** Tests run a fake CLI: `command` + `commandArgs` go before the real arguments. */
  command?: string;
  commandArgs?: string[];
  /** The daemon's key registry, read at each open (it can be set after construction). */
  keys?: () => KeyRegistry | undefined;
}

export class ClaudeSummarizer implements Summarizer {
  private n = 0;
  constructor(private readonly o: ClaudeSummarizerOptions) {}

  open(opts: SummarizerOpenOptions): SummarizerSession {
    const { manager } = this.o;
    const id = `endless-compaction-${++this.n}-${Date.now()}`;
    let first = false;
    let text = '';
    let failed: string | null = null;
    let waiting: { resolve: (s: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;

    const keys = this.o.keys?.();
    const minted = keys?.mint({ kind: 'chat', startedBy: 'summarizer' });
    const revoke = () => { if (minted) keys!.revoke(minted.handle); };

    const fail = (msg: string) => {
      failed = msg;
      if (waiting) { clearTimeout(waiting.timer); waiting.reject(new Error(msg)); waiting = null; }
      if (manager.isAlive(id)) manager.kill(id);
    };
    const onEvent = (tid: string, ev: any) => {
      if (tid !== id) return;
      if (!first && (ev?.type === 'stream_event' || ev?.type === 'assistant')) { first = true; opts.onFirstToken(); }
      if (ev?.type === 'assistant' && ev.parent_tool_use_id == null && Array.isArray(ev.message?.content)) {
        for (const b of ev.message.content) {
          if (b?.type === 'tool_use') { fail(`a compaction called a tool (${b.name})`); return; }
          if (b?.type === 'text') text += b.text ?? '';
        }
      }
      if (ev?.type === 'result') {
        const u = usageOf(ev.usage);
        if (u) this.o.onUsage?.(u);
        if (!waiting) return;
        clearTimeout(waiting.timer);
        const w = waiting;
        waiting = null;
        const reply = text;
        text = '';
        if (ev.is_error) w.reject(new Error(String(ev.result ?? 'the compaction failed')));
        else w.resolve(reply);
      }
    };
    const onExit = (tid: string, code: number) => {
      // Mark the session dead even between asks, so the next ask rejects at once.
      if (tid !== id) return;
      revoke();
      const msg = `the compaction process exited (${code})`;
      if (waiting) fail(msg);
      else failed ??= msg;
    };
    manager.on('event', onEvent);
    manager.on('exit', onExit);
    try {
      manager.spawn(id, {
        command: this.o.command ?? 'claude',
        args: [...(this.o.commandArgs ?? []), ...endlessClaudeArgs({ model: this.o.model ?? SUMMARY_MODEL, effort: this.o.effort ?? SUMMARY_EFFORT, systemPrompt: opts.systemPrompt, mcpConfigPath: this.o.mcpConfigPath, userTools: false })],
        workDir: this.o.chatDir,
        env: minted ? { ...COMPACTION_ENV, DISPATCH_AUTH: minted.key } : COMPACTION_ENV,
        toolPolicy: () => ({ allow: false, message: 'Compaction: call no tools.' }),
      });
    } catch (err) {
      // The process never started: nothing else will revoke this key or detach these listeners.
      manager.off('event', onEvent);
      manager.off('exit', onExit);
      revoke();
      throw err;
    }

    return {
      ask: (msg: string) => new Promise<string>((resolve, reject) => {
        if (failed) { reject(new Error(failed)); return; }
        const timer = setTimeout(() => fail('the compaction timed out'), this.o.askTimeoutMs ?? 120_000);
        waiting = { resolve, reject, timer };
        manager.sendMessage(id, msg);
      }),
      close: () => {
        manager.off('event', onEvent);
        manager.off('exit', onExit);
        if (manager.isAlive(id)) manager.kill(id);
        revoke();
      },
    };
  }
}
