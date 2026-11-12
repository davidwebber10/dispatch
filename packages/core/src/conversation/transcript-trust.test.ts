import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openedTranscriptTrusted, transcriptPathTrusted } from './transcript-trust.js';

let tmp: string; let root: string; let outside: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-trust-'));
  root = path.join(tmp, 'home', '.claude', 'projects'); fs.mkdirSync(path.join(root, 'p'), { recursive: true });
  outside = path.join(tmp, 'root-only'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.jsonl'), '{"a":1}\n', { mode: 0o600 });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const me = typeof process.getuid === 'function' ? process.getuid() : 0;

describe('transcriptPathTrusted', () => {
  it('a plain file inside the transcript root is trusted', () => {
    const f = path.join(root, 'p', 's.jsonl'); fs.writeFileSync(f, '\n');
    expect(transcriptPathTrusted(f, [root], null)).toBe(true);
    expect(transcriptPathTrusted(f, [root], me)).toBe(true);
  });
  it('a planted link to a root-only file is not', () => {
    const f = path.join(root, 'p', 's.jsonl'); fs.symlinkSync(path.join(outside, 'secret.jsonl'), f);
    expect(transcriptPathTrusted(f, [root], null)).toBe(false);
  });
  it('a project folder replaced by a link that leads out of the root is not', () => {
    fs.rmSync(path.join(root, 'p'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'p'));
    expect(transcriptPathTrusted(path.join(root, 'p', 'secret.jsonl'), [root], null)).toBe(false);
  });
  it('a file of another owner is not, with privilege separation', () => {
    const f = path.join(root, 'p', 's.jsonl'); fs.writeFileSync(f, '\n');
    expect(transcriptPathTrusted(f, [root], me + 1)).toBe(false);
  });
  it('a missing file or root is not', () => {
    expect(transcriptPathTrusted(path.join(root, 'p', 'none.jsonl'), [root], null)).toBe(false);
    const f = path.join(root, 'p', 's.jsonl'); fs.writeFileSync(f, '\n');
    expect(transcriptPathTrusted(f, [path.join(tmp, 'no-root')], null)).toBe(false);
  });
});

describe('openedTranscriptTrusted', () => {
  it('a plain file of the agent user only', () => {
    const st = fs.statSync(path.join(outside, 'secret.jsonl'));
    expect(openedTranscriptTrusted(st, null)).toBe(true);
    expect(openedTranscriptTrusted(st, me)).toBe(true);
    expect(openedTranscriptTrusted(st, me + 1)).toBe(false);
    expect(openedTranscriptTrusted(fs.statSync(outside), null)).toBe(false);
  });
});
