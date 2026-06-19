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
});
