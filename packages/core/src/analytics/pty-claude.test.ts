import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readClaudeTail } from './pty-claude.js';

function line(model: string, output: number) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      model,
      content: [{ type: 'text', text: 'x' }, { type: 'tool_use', name: 'Read' }],
      usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 },
    },
  });
}

describe('readClaudeTail', () => {
  let dir: string, file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-claude-'));
    file = path.join(dir, 's.jsonl');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('sums only the bytes after the offset', () => {
    fs.writeFileSync(file, line('claude-opus-5', 20) + '\n');
    const first = readClaudeTail(file, 0)!;
    expect(first.output).toBe(20);
    expect(first.messages).toBe(1);
    expect(first.toolCalls).toBe(1);
    expect(first.model).toBe('claude-opus-5');

    fs.appendFileSync(file, line('claude-opus-5', 7) + '\n');
    const second = readClaudeTail(file, first.nextOffset)!;
    expect(second.output).toBe(7);      // NOT 27 — the first message is behind the offset
    expect(second.messages).toBe(1);
    expect(second.nextOffset).toBe(fs.statSync(file).size);
  });

  it('reports zero usage and an advanced offset when nothing new arrived', () => {
    fs.writeFileSync(file, line('claude-opus-5', 20) + '\n');
    const first = readClaudeTail(file, 0)!;
    const again = readClaudeTail(file, first.nextOffset)!;
    expect(again.output).toBe(0);
    expect(again.messages).toBe(0);
    expect(again.nextOffset).toBe(first.nextOffset);
  });

  // Compaction guard: a file shorter than the cursor means something rewrote it.
  // Reading from a stale offset would return garbage, so re-read from the start.
  it('re-reads from zero when the file is shorter than the offset', () => {
    fs.writeFileSync(file, line('claude-opus-5', 20) + '\n');
    const r = readClaudeTail(file, 999999)!;
    expect(r.output).toBe(20);
  });

  it('returns null for a missing file', () => {
    expect(readClaudeTail(path.join(dir, 'nope.jsonl'), 0)).toBeNull();
  });

  it('ignores malformed lines without throwing', () => {
    fs.writeFileSync(file, 'not json\n' + line('claude-opus-5', 5) + '\n\n');
    const r = readClaudeTail(file, 0)!;
    expect(r.output).toBe(5);
  });
});
