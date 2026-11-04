import { describe, it, expect, vi, afterEach } from 'vitest';
import { RunStreamParser } from './run-stream.js';

const line = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n';

afterEach(() => { delete process.env.DISPATCH_MAX_STREAM_LINE_BYTES; vi.restoreAllMocks(); });

describe('RunStreamParser line cap (SEC-23)', () => {
  it('parses normal lines, split anywhere', () => {
    const p = new RunStreamParser('claude-code');
    const raw = line('one') + line('two');
    const events = [...p.feed(raw.slice(0, 20)), ...p.feed(raw.slice(20))];
    expect(events.map((e: any) => e.text)).toEqual(['one', 'two']);
  });

  it('drops a partial line past the cap, keeps memory bounded, and resumes at the next newline', () => {
    process.env.DISPATCH_MAX_STREAM_LINE_BYTES = '1000';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = new RunStreamParser('claude-code');
    const out: any[] = [];
    out.push(...p.feed(line('before')));
    // A huge line arrives in pieces with no newline.
    for (let i = 0; i < 50; i++) out.push(...p.feed('x'.repeat(500)));
    expect((p as any).buf.length).toBeLessThanOrEqual(1000);
    // Its tail and the newline, then a good line.
    out.push(...p.feed('tail\n' + line('after')));
    expect(out.map((e) => e.text)).toEqual(['before', 'after']);
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0][0]).toMatch(/dropped an agent output line.*DISPATCH_MAX_STREAM_LINE_BYTES/);
  });

  it('drops a complete over-long line fed in one chunk and keeps the lines around it', () => {
    process.env.DISPATCH_MAX_STREAM_LINE_BYTES = '1000';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = new RunStreamParser('claude-code');
    const events = p.feed(line('a') + line('y'.repeat(5000)) + line('b'));
    expect(events.map((e: any) => e.text)).toEqual(['a', 'b']);
  });

  it('a line under the cap is never dropped, and 0 turns the cap off', () => {
    process.env.DISPATCH_MAX_STREAM_LINE_BYTES = '0';
    const p = new RunStreamParser('claude-code');
    const big = 'z'.repeat(200_000);
    expect(p.feed(line(big)).map((e: any) => e.text.length)).toEqual([200_000]);
  });

  it('counts bytes, not characters: multibyte text over the cap is dropped, whole or in pieces', () => {
    process.env.DISPATCH_MAX_STREAM_LINE_BYTES = '600';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cjk = '汉'.repeat(150); // 150 characters, 450 bytes of text, 450 + JSON wrapper is under 600
    const big = '汉'.repeat(300); // 900 bytes of text
    const ok = new RunStreamParser('claude-code').feed(line(cjk));
    expect(ok.map((e: any) => e.text.length)).toEqual([150]);
    expect(new RunStreamParser('claude-code').feed(line(big))).toEqual([]);
    // In pieces: the partial buffer is over 600 bytes before 600 characters.
    const p = new RunStreamParser('claude-code');
    const out: any[] = [];
    const raw = line(big);
    for (let i = 0; i < raw.length; i += 100) out.push(...p.feed(raw.slice(i, i + 100)));
    out.push(...p.feed(line('after')));
    expect(out.map((e) => e.text)).toEqual(['after']);
  });
});
