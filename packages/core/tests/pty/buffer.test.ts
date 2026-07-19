import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../../src/pty/buffer.js';

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
