import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readCodexTail } from './codex-frames.js';

const tokenCount = (input: number, cached: number, output: number) => JSON.stringify({
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input, cached_input_tokens: cached,
        output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output,
      },
      last_token_usage: { input_tokens: 999999, cached_input_tokens: 0, output_tokens: 999999, reasoning_output_tokens: 0, total_tokens: 1999998 },
    },
  },
});

const turnContext = (model: string) => JSON.stringify({ type: 'turn_context', payload: { model } });

describe('readCodexTail', () => {
  let dir: string, file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-frames-'));
    file = path.join(dir, 'r.jsonl');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('takes the NEWEST total, not the first', () => {
    fs.writeFileSync(file, [tokenCount(100, 10, 5), tokenCount(300, 40, 9)].join('\n') + '\n');
    expect(readCodexTail(file)!.totals).toEqual({ input: 300, cached: 40, output: 9 });
  });

  it('takes the newest model from turn_context', () => {
    fs.writeFileSync(file, [turnContext('gpt-5.6-terra'), tokenCount(1, 0, 1), turnContext('gpt-5.6-sol')].join('\n') + '\n');
    expect(readCodexTail(file)!.model).toBe('gpt-5.6-sol');
  });

  // The guard on a measured 0.96% overcount. last_token_usage is deliberately absurd
  // in these fixtures: if anything ever reads it, these numbers make it obvious.
  it('never reads last_token_usage', () => {
    fs.writeFileSync(file, tokenCount(50, 5, 7) + '\n');
    const t = readCodexTail(file)!.totals!;
    expect(t.input).toBe(50);
    expect(t.output).toBe(7);
  });

  it('returns null totals when the file has no token_count at all', () => {
    fs.writeFileSync(file, turnContext('gpt-5.6-sol') + '\n');
    const r = readCodexTail(file)!;
    expect(r.totals).toBeNull();
    expect(r.model).toBe('gpt-5.6-sol');
  });

  it('returns null for a missing file and survives malformed lines', () => {
    expect(readCodexTail(path.join(dir, 'nope.jsonl'))).toBeNull();
    fs.writeFileSync(file, 'garbage\n' + tokenCount(2, 0, 3) + '\n');
    expect(readCodexTail(file)!.totals).toEqual({ input: 2, cached: 0, output: 3 });
  });

  it('widens the read when the tail window holds no token_count', () => {
    const filler = 'x'.repeat(4096);
    fs.writeFileSync(file, tokenCount(11, 1, 2) + '\n' + JSON.stringify({ type: 'response_item', payload: { filler } }) + '\n');
    expect(readCodexTail(file, 512)!.totals).toEqual({ input: 11, cached: 1, output: 2 });
  });

  it('widens when the tail holds a total but no model', () => {
    const filler = 'x'.repeat(4096);
    fs.writeFileSync(file, [
      turnContext('gpt-5.6-sol'),
      JSON.stringify({ type: 'response_item', payload: { filler } }),
      tokenCount(7, 1, 3),
    ].join('\n') + '\n');

    const r = readCodexTail(file, 512)!;
    expect(r.totals).toEqual({ input: 7, cached: 1, output: 3 });
    expect(r.model).toBe('gpt-5.6-sol');   // '' before the fix
  });
});
