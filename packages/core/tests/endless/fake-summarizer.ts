import type { Summarizer, SummarizerOpenOptions, SummarizerSession } from '../../src/endless/summarizer.js';

export class FakeSession implements SummarizerSession {
  asks: string[] = [];
  closed = false;
  private pending: { resolve: (s: string) => void; reject: (e: Error) => void }[] = [];
  constructor(readonly opts: SummarizerOpenOptions, private readonly autoFirstToken: boolean) {}
  ask(text: string): Promise<string> {
    this.asks.push(text);
    if (this.autoFirstToken && this.asks.length === 1) this.opts.onFirstToken();
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  reply(text: string): void { this.pending.shift()!.resolve(text); }
  fail(message: string): void { this.pending.shift()!.reject(new Error(message)); }
  close(): void { this.closed = true; }
}

export class FakeSummarizer implements Summarizer {
  sessions: FakeSession[] = [];
  constructor(private readonly autoFirstToken = true) {}
  open(opts: SummarizerOpenOptions): FakeSession {
    const s = new FakeSession(opts, this.autoFirstToken);
    this.sessions.push(s);
    return s;
  }
}

/** Let queued promise callbacks and setImmediate work run. */
export const settle = async (): Promise<void> => {
  for (let k = 0; k < 30; k++) await new Promise((r) => setImmediate(r));
};
