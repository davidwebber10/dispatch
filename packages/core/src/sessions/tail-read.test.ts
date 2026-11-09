import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readTail } from './tail-read.js';

describe('readTail', () => {
  let dir: string;
  let file: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-read-')); file = path.join(dir, 't.jsonl'); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns whole lines only', () => {
    const lines = Array.from({ length: 100 }, (_, i) => JSON.stringify({ i, pad: 'p'.repeat(40) }));
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const r = readTail(file, 1000);
    expect(r.truncatedHead).toBe(true);
    const got = r.text.split('\n').filter(Boolean);
    expect(got.length).toBeGreaterThan(5);
    for (const line of got) expect(() => JSON.parse(line)).not.toThrow();
    // The lines are the newest ones, in order, with no gap.
    expect(got).toEqual(lines.slice(lines.length - got.length));
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(1000);
  });

  it('truncatedHead is false for a small file', () => {
    fs.writeFileSync(file, 'a\nb\nc\n');
    expect(readTail(file, 1000)).toEqual({ text: 'a\nb\nc\n', truncatedHead: false });
    // Exactly the file size: still the whole file.
    expect(readTail(file, 6)).toEqual({ text: 'a\nb\nc\n', truncatedHead: false });
  });

  it('a multi-byte character at the cut is not broken', () => {
    // Each line is 3-byte characters. Any cut that is not on a line start lands inside a character or a line.
    const lines = Array.from({ length: 50 }, (_, i) => `${i}:` + '€'.repeat(20));
    fs.writeFileSync(file, lines.join('\n') + '\n');
    for (let max = 60; max < 200; max++) {
      const r = readTail(file, max);
      expect(r.text).not.toContain('�');
      const got = r.text.split('\n').filter(Boolean);
      expect(got).toEqual(lines.slice(lines.length - got.length));
    }
  });

  it('keeps the first line when the cut is exactly on a line start', () => {
    fs.writeFileSync(file, 'first\nsecond\nthird\n');
    // 'second\nthird\n' is 13 bytes: the byte before the cut is a newline, so 'second' is whole.
    expect(readTail(file, 13)).toEqual({ text: 'second\nthird\n', truncatedHead: true });
    expect(readTail(file, 12)).toEqual({ text: 'third\n', truncatedHead: true });
  });

  it('gives an empty text when the window holds no line start', () => {
    fs.writeFileSync(file, 'x'.repeat(500));
    expect(readTail(file, 100)).toEqual({ text: '', truncatedHead: true });
  });

  it('an empty file gives an empty text; a missing file throws', () => {
    fs.writeFileSync(file, '');
    expect(readTail(file, 100)).toEqual({ text: '', truncatedHead: false });
    expect(() => readTail(path.join(dir, 'missing.jsonl'), 100)).toThrow();
  });
});
