import { describe, expect, test } from 'vitest';
import { RingBuffer, REPLAY_STATE_PREAMBLE } from './buffer.js';

describe('RingBuffer.trimToNow — width-change eviction', () => {
  test('empties the replayable window but keeps the lifetime counters monotonic', () => {
    const b = new RingBuffer();
    b.write('era-one line\n');
    const written = b.totalWritten();
    b.trimToNow();
    expect(b.getContents()).toBe('');
    expect(b.size()).toBe(0);
    expect(b.totalWritten()).toBe(written); // nothing un-written, only evicted
    expect(b.startOffset()).toBe(written); // the next byte is the first replayable one
  });

  test('marks the replay incomplete — an attaching client must get the repaint nudge', () => {
    const b = new RingBuffer();
    b.write('old width\n');
    expect(b.isReplayComplete()).toBe(true);
    b.trimToNow();
    expect(b.isReplayComplete()).toBe(false);
  });

  test('bytes written after the trim replay normally, with the slice anchored past the trim', () => {
    const b = new RingBuffer();
    b.write('wrapped-for-250-cols......\n');
    b.trimToNow();
    const boundary = b.startOffset();
    b.write('fresh line at the new width\n');
    expect(b.getContents()).toBe('fresh line at the new width\n');
    const slice = b.getSlice();
    // A mid-stream slice carries the state preamble and starts at the boundary.
    expect(slice.data).toBe(REPLAY_STATE_PREAMBLE + 'fresh line at the new width\n');
    expect(slice.startOffset).toBe(boundary);
  });

  test('trimming an empty ring is a no-op on the counters', () => {
    const b = new RingBuffer();
    b.trimToNow();
    expect(b.size()).toBe(0);
    expect(b.totalWritten()).toBe(0);
    expect(b.getContents()).toBe('');
  });
});
