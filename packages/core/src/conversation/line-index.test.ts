import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LineIndex } from './line-index.js';

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-line-index-'));
  file = path.join(tmp, 't.jsonl');
  LineIndex.clearCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  LineIndex.clearCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The bytes of lines [a, b) as text, read through the index's own range. */
function slice(index: LineIndex, a: number, b: number): string {
  const { offset, length } = index.range(a, b);
  return fs.readFileSync(file).subarray(offset, offset + length).toString('utf8');
}

/** Records the (position, length) of every read that a FileHandle opened on `file` makes. */
function spyOnReads(): { position: number; length: number }[] {
  const reads: { position: number; length: number }[] = [];
  const realOpen = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
    const fh = await realOpen(...args);
    const realRead = fh.read.bind(fh) as (...a: unknown[]) => Promise<{ bytesRead: number; buffer: Buffer }>;
    (fh as unknown as { read: unknown }).read = async (buf: Buffer, off: number, len: number, pos: number) => {
      const r = await realRead(buf, off, len, pos);
      reads.push({ position: pos, length: r.bytesRead });
      return r;
    };
    return fh;
  });
  return reads;
}

describe('LineIndex', () => {
  it('counts complete lines only (a half-written last line is not counted)', async () => {
    fs.writeFileSync(file, 'one\ntwo\nthr');
    const index = await LineIndex.open(file);
    expect(index.lineCount).toBe(2);

    fs.appendFileSync(file, 'ee\n');
    await index.refresh();
    expect(index.lineCount).toBe(3);
    expect(slice(index, 2, 3)).toBe('three\n');
  });

  it('an empty file has no lines, and a missing file rejects', async () => {
    fs.writeFileSync(file, '');
    expect((await LineIndex.open(file)).lineCount).toBe(0);
    await expect(LineIndex.open(path.join(tmp, 'absent.jsonl'))).rejects.toThrow();
  });

  it('refresh after an append reads only the new bytes', async () => {
    const first = 'a'.repeat(5000) + '\n' + 'b'.repeat(5000) + '\n';
    fs.writeFileSync(file, first);
    const index = await LineIndex.open(file);
    expect(index.lineCount).toBe(2);

    const added = 'c'.repeat(300) + '\n' + 'd'.repeat(300) + '\n';
    fs.appendFileSync(file, added);
    const reads = spyOnReads();
    await index.refresh();

    expect(index.lineCount).toBe(4);
    expect(reads.length).toBeGreaterThan(0);
    // One check byte (the last indexed newline) may be read again; nothing before it is.
    for (const r of reads) expect(r.position).toBeGreaterThanOrEqual(first.length - 1);
    expect(reads.reduce((n, r) => n + r.length, 0)).toBeLessThanOrEqual(added.length + 1);
  });

  it('a refresh with no new bytes reads at most the check byte', async () => {
    fs.writeFileSync(file, 'x\ny\n');
    const index = await LineIndex.open(file);
    const reads = spyOnReads();
    await index.refresh();
    expect(reads.reduce((n, r) => n + r.length, 0)).toBeLessThanOrEqual(1);
    expect(index.lineCount).toBe(2);
  });

  it('a truncated file resets the index', async () => {
    fs.writeFileSync(file, 'one\ntwo\nthree\nfour\n');
    const index = await LineIndex.open(file);
    expect(index.lineCount).toBe(4);

    fs.writeFileSync(file, 'uno\ndos\n'); // same inode, smaller size
    await index.refresh();
    expect(index.lineCount).toBe(2);
    expect(slice(index, 0, 2)).toBe('uno\ndos\n');
  });

  it('a file rewritten to a larger size on the same inode resets the index', async () => {
    fs.writeFileSync(file, 'one\ntwo\n');
    const index = await LineIndex.open(file);
    fs.writeFileSync(file, 'a much longer first line\nsecond\nthird\n');
    await index.refresh();
    expect(index.lineCount).toBe(3);
    expect(slice(index, 0, 1)).toBe('a much longer first line\n');
  });

  it('a new inode (rotation) resets the index', async () => {
    fs.writeFileSync(file, 'one\ntwo\nthree\n');
    const index = await LineIndex.open(file);
    const next = path.join(tmp, 'next.jsonl');
    fs.writeFileSync(next, 'alpha\nbeta\ngamma\ndelta\nepsilon\n');
    fs.renameSync(next, file);
    await index.refresh();
    expect(index.lineCount).toBe(5);
    expect(slice(index, 4, 5)).toBe('epsilon\n');
  });

  it('range returns the exact bytes of lines N to M', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}-${'z'.repeat(i)}`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const index = await LineIndex.open(file);
    expect(index.lineCount).toBe(50);
    expect(slice(index, 0, 1)).toBe(lines[0] + '\n');
    expect(slice(index, 10, 13)).toBe(lines.slice(10, 13).join('\n') + '\n');
    expect(slice(index, 49, 50)).toBe(lines[49] + '\n');
    expect(index.range(7, 7)).toEqual({ offset: index.range(7, 8).offset, length: 0 });
    expect(() => index.range(0, 51)).toThrow(RangeError);
    expect(() => index.range(5, 4)).toThrow(RangeError);
  });

  it('multi-byte text keeps correct offsets', async () => {
    const lines = ['héllo wörld', '日本語のテキスト', 'emoji 🎉🎉 end', 'plain'];
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const index = await LineIndex.open(file);
    expect(index.lineCount).toBe(4);
    for (let i = 0; i < lines.length; i++) expect(slice(index, i, i + 1)).toBe(lines[i] + '\n');
    expect(slice(index, 1, 3)).toBe(lines[1] + '\n' + lines[2] + '\n');
  });

  it('indexes a file larger than one chunk, with a line that crosses a chunk edge', async () => {
    // 1 MB chunks: 3.5 MB of 1,000-byte lines, then one 1.5 MB line.
    const line = 'q'.repeat(999);
    const many = Array.from({ length: 3500 }, () => line).join('\n') + '\n';
    const big = 'B'.repeat(1_500_000);
    fs.writeFileSync(file, many + big + '\n' + 'last\n');
    const index = await LineIndex.open(file);
    expect(index.lineCount).toBe(3502);
    expect(index.range(3500, 3501)).toEqual({ offset: many.length, length: big.length + 1 });
    expect(slice(index, 3501, 3502)).toBe('last\n');
  });

  it('a snapshot stays usable after the file is reset', async () => {
    fs.writeFileSync(file, 'one\ntwo\nthree\n');
    const index = await LineIndex.open(file);
    const snap = index.snapshot();
    fs.writeFileSync(file, 'x\n');
    await index.refresh();
    expect(index.lineCount).toBe(1);
    expect(snap.lineCount).toBe(3);
    expect(snap.range(1, 3)).toEqual({ offset: 4, length: 10 });
  });

  it('concurrent refreshes do not count a line twice', async () => {
    fs.writeFileSync(file, Array.from({ length: 1000 }, (_, i) => `l${i}`).join('\n') + '\n');
    const index = await LineIndex.open(file);
    fs.appendFileSync(file, 'more\nand more\n');
    await Promise.all([index.refresh(), index.refresh(), index.refresh()]);
    expect(index.lineCount).toBe(1002);
  });

  it('open returns the same index for the same file, and keeps 8 at most', async () => {
    fs.writeFileSync(file, 'one\n');
    const a = await LineIndex.open(file);
    expect(await LineIndex.open(file)).toBe(a);
    for (let i = 0; i < 8; i++) {
      const other = path.join(tmp, `o${i}.jsonl`);
      fs.writeFileSync(other, 'x\n');
      await LineIndex.open(other);
    }
    expect(LineIndex.cachedCount()).toBe(8);
    expect(await LineIndex.open(file)).not.toBe(a); // evicted; built again
  });
});
