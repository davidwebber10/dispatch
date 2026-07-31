import { describe, it, expect } from 'vitest';
import { RingBuffer, REPLAY_STATE_PREAMBLE } from '../../src/pty/buffer.js';

describe('RingBuffer', () => {
  it('stores and retrieves data', () => {
    const buf = new RingBuffer(100);
    buf.write('hello');
    expect(buf.getContents()).toBe('hello');
  });

  it('respects max size by dropping oldest data', () => {
    const buf = new RingBuffer(10);
    buf.write('12345');
    buf.write('67890');
    buf.write('abc');
    const contents = buf.getContents();
    expect(contents.length).toBeLessThanOrEqual(10);
    expect(contents).toContain('abc');
  });

  it('tracks last write time', () => {
    const buf = new RingBuffer(100);
    expect(buf.lastWriteAt).toBeNull();
    buf.write('x');
    expect(buf.lastWriteAt).toBeInstanceOf(Date);
  });

  it('can return a bounded tail', () => {
    const buf = new RingBuffer(100);
    buf.write('12345');
    buf.write('67890');
    buf.write('abcde');
    expect(buf.getContents(7)).toBe('890abcde'.slice(-7));
  });

  it('clears', () => {
    const buf = new RingBuffer(100);
    buf.write('data');
    buf.clear();
    expect(buf.getContents()).toBe('');
  });

  it('reports a complete replay while nothing has been dropped', () => {
    const buf = new RingBuffer(100);
    buf.write('12345');
    expect(buf.isReplayComplete()).toBe(true);
    expect(buf.isReplayComplete(100)).toBe(true);
  });

  it('reports an incomplete replay once old data is dropped', () => {
    const buf = new RingBuffer(10);
    buf.write('12345');
    buf.write('67890');
    buf.write('abc'); // pushes past 10 bytes → front chunk dropped
    expect(buf.isReplayComplete()).toBe(false);
  });

  it('reports an incomplete replay when the tail cap cuts the contents', () => {
    const buf = new RingBuffer(100);
    buf.write('12345');
    buf.write('67890');
    expect(buf.isReplayComplete(4)).toBe(false); // caller asks for fewer bytes than stored
  });

  it('clear() resets the truncation state', () => {
    const buf = new RingBuffer(10);
    buf.write('1234567890');
    buf.write('abcde'); // forces a drop
    expect(buf.isReplayComplete()).toBe(false);
    buf.clear();
    expect(buf.isReplayComplete()).toBe(true);
  });

  it('size() reports N for a ring fed N bytes (no wrap)', () => {
    const buf = new RingBuffer(100);
    buf.write('hello');
    expect(buf.size()).toBe(Buffer.byteLength('hello', 'utf8'));
  });

  it('size() reports the retained (capped) size once wrapped, NOT the lifetime total written', () => {
    const buf = new RingBuffer(10);
    buf.write('12345'); // 5 bytes
    buf.write('67890'); // +5 = 10 bytes
    buf.write('abc');   // +3 = 13 -> trims oldest chunk ('12345', 5 bytes) -> retained 8
    const lifetimeTotalWritten = 5 + 5 + 3; // 13 — what size() must NOT return
    expect(buf.size()).toBe(8);
    expect(buf.size()).toBeLessThan(lifetimeTotalWritten);
    expect(buf.size()).toBe(Buffer.byteLength(buf.getContents(), 'utf8')); // matches what a full replay would return
  });

  it('size() is 0 for a fresh ring and resets to 0 after clear()', () => {
    const buf = new RingBuffer(100);
    expect(buf.size()).toBe(0);
    buf.write('data');
    expect(buf.size()).toBeGreaterThan(0);
    buf.clear();
    expect(buf.size()).toBe(0);
  });
});

describe('RingBuffer offsets', () => {
  it('startOffset() stays 0 and totalWritten() counts every byte while nothing is evicted', () => {
    const buf = new RingBuffer(100);
    expect(buf.startOffset()).toBe(0);
    expect(buf.totalWritten()).toBe(0);
    buf.write('12345');
    buf.write('67890');
    expect(buf.startOffset()).toBe(0);
    expect(buf.totalWritten()).toBe(10);
    expect(buf.totalWritten()).toBe(buf.size());
  });

  it('tracks evicted bytes across a wrap: startOffset() moves, totalWritten() keeps counting', () => {
    const buf = new RingBuffer(10);
    buf.write('12345'); // 5 retained
    buf.write('67890'); // 10 retained
    buf.write('abc');   // 13 > 10 -> evicts '12345'
    expect(buf.startOffset()).toBe(5);
    expect(buf.totalWritten()).toBe(13);
    expect(buf.size()).toBe(8);

    buf.write('defghij'); // 15 > 10 -> evicts '67890'
    expect(buf.startOffset()).toBe(10);
    expect(buf.totalWritten()).toBe(20);
    expect(buf.size()).toBe(10);
    // The retained bytes really are the lifetime stream from startOffset() on.
    expect(buf.getContents()).toBe('1234567890abcdefghij'.slice(buf.startOffset()));
  });

  it('totalWritten() never decreases while the ring wraps repeatedly', () => {
    const buf = new RingBuffer(20);
    let seen = 0;
    for (let i = 0; i < 40; i++) {
      buf.write(`chunk-${i}\n`);
      expect(buf.totalWritten()).toBeGreaterThanOrEqual(seen);
      seen = buf.totalWritten();
      expect(buf.totalWritten()).toBe(buf.startOffset() + buf.size());
    }
    expect(buf.startOffset()).toBeGreaterThan(0);
  });

  it('clear() resets the offsets (a cleared ring starts from 0 again)', () => {
    const buf = new RingBuffer(10);
    buf.write('1234567890');
    buf.write('abcde'); // forces an eviction
    expect(buf.startOffset()).toBeGreaterThan(0);
    buf.clear();
    expect(buf.startOffset()).toBe(0);
    expect(buf.totalWritten()).toBe(0);
    expect(buf.getSlice().startOffset).toBe(0);
    expect(buf.getSlice().data).toBe(''); // no preamble on a from-zero slice
  });
});

describe('RingBuffer.getSlice', () => {
  const LINES = ['alpha\n', 'bravo\n', 'charlie\n', 'delta\n', 'echo\n'];
  const STREAM = LINES.join('');

  function fed(maxBytes: number): RingBuffer {
    const buf = new RingBuffer(maxBytes);
    for (const line of LINES) buf.write(line);
    return buf;
  }

  it('startOffset points at the first REAL byte of the payload (preamble excluded)', () => {
    const buf = fed(1000); // nothing evicted
    const slice = buf.getSlice(12);
    expect(slice.data.startsWith(REPLAY_STATE_PREAMBLE)).toBe(true);
    const payload = slice.data.slice(REPLAY_STATE_PREAMBLE.length);
    expect(payload).toBe(STREAM.slice(slice.startOffset));
    expect(payload).toBe('delta\necho\n');
    expect(slice.startOffset).toBe(STREAM.indexOf('delta\n'));
  });

  it('startOffset stays absolute after the ring has evicted its head', () => {
    const buf = fed(16); // wraps: 'alpha\n'/'bravo\n' get evicted
    expect(buf.startOffset()).toBeGreaterThan(0);
    const slice = buf.getSlice(12);
    const payload = slice.data.slice(REPLAY_STATE_PREAMBLE.length);
    // The offset is a position in the LIFETIME stream, not in the retained ring.
    expect(payload).toBe(STREAM.slice(slice.startOffset));
    expect(slice.startOffset).toBeGreaterThanOrEqual(buf.startOffset());
    expect(slice.startOffset).toBeLessThan(buf.totalWritten());
  });

  it('an uncapped slice of a wrapped ring reports the ring head, aligned forward', () => {
    const buf = fed(16);
    const slice = buf.getSlice();
    const payload = slice.data.slice(REPLAY_STATE_PREAMBLE.length);
    expect(payload).toBe(STREAM.slice(slice.startOffset));
    expect(STREAM[slice.startOffset - 1]).toBe('\n'); // never a partial line
  });

  it('advances forward past the next newline when the cut lands mid-line', () => {
    const buf = new RingBuffer(1000);
    buf.write('line one\nline two\nline three\n'); // 9 + 9 + 11 bytes
    // 12-byte cap cuts at byte 17 — the '\n' that ends 'line two', i.e. mid-line.
    const slice = buf.getSlice(12);
    const payload = slice.data.slice(REPLAY_STATE_PREAMBLE.length);
    expect(payload).toBe('line three\n');
    expect(payload.startsWith('\n')).toBe(false); // the raw cut would have led with '\n'
    expect(slice.startOffset).toBe(18);
  });

  it('never begins inside an incomplete escape sequence', () => {
    const buf = new RingBuffer(1000);
    buf.write('AAAA\x1b[31mBBBB'); // no newline anywhere: only the escape guard can save this
    // 7-byte cap cuts at byte 6 — between the '[' and the 'm' of \x1b[31m.
    const slice = buf.getSlice(7);
    const payload = slice.data.slice(REPLAY_STATE_PREAMBLE.length);
    expect(payload).toBe('BBBB');
    expect(payload).not.toMatch(/^[0-9;]*m/); // no orphaned tail of the CSI
    expect(slice.startOffset).toBe('AAAA\x1b[31m'.length);
  });

  it('keeps a cut that already lands on a line start exactly where it is', () => {
    const buf = new RingBuffer(1000);
    buf.write('one\ntwo\nthree\n'); // 4 + 4 + 6
    const slice = buf.getSlice(6); // cuts at byte 8 — right after 'two\n'
    expect(slice.data.slice(REPLAY_STATE_PREAMBLE.length)).toBe('three\n');
    expect(slice.startOffset).toBe(8);
  });

  it('prefixes the state preamble whenever the slice starts after byte 0', () => {
    const buf = fed(1000);
    expect(buf.getSlice(12).data.startsWith(REPLAY_STATE_PREAMBLE)).toBe(true);

    const wrapped = fed(16);
    expect(wrapped.getSlice().data.startsWith(REPLAY_STATE_PREAMBLE)).toBe(true);
    expect(wrapped.getSlice(8).data.startsWith(REPLAY_STATE_PREAMBLE)).toBe(true);
  });

  it('emits NO preamble and stays byte-identical to getContents() for a complete replay from 0', () => {
    const buf = fed(1000);
    for (const maxBytes of [undefined, 0, STREAM.length, STREAM.length + 1, 4_000_000]) {
      const slice = buf.getSlice(maxBytes);
      expect(slice.startOffset).toBe(0);
      expect(slice.data).toBe(buf.getContents(maxBytes));
      expect(slice.data).toBe(STREAM);
      expect(slice.data.includes('\x1b[?1049l')).toBe(false);
    }
  });

  it('an empty ring slices to nothing at offset 0', () => {
    const buf = new RingBuffer(100);
    expect(buf.getSlice()).toEqual({ data: '', startOffset: 0 });
    expect(buf.getSlice(10)).toEqual({ data: '', startOffset: 0 });
  });
});
