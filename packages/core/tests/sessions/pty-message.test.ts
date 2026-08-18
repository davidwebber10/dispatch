import { describe, it, expect } from 'vitest';
import { ptyMessagePayload, flattenForPty } from '../../src/sessions/pty-message.js';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

describe('ptyMessagePayload', () => {
  it('sends single-line text as plain text + CR (the proven sendFileReference shape)', () => {
    expect(ptyMessagePayload('ship it')).toBe('ship it\r');
    // No bracketed paste for the common case.
    expect(ptyMessagePayload('ship it')).not.toContain(PASTE_START);
  });

  it('wraps multi-line text in bracketed paste so the TUI does not submit on each newline', () => {
    const out = ptyMessagePayload('line one\nline two');
    expect(out).toBe(`${PASTE_START}line one\nline two${PASTE_END}\r`);
    // Exactly ONE submit, at the very end — the whole point.
    expect(out.split('\r')).toHaveLength(2);
    expect(out.endsWith('\r')).toBe(true);
  });

  it('normalizes CRLF and bare CR to \\n so no stray CR submits mid-message', () => {
    const crlf = ptyMessagePayload('a\r\nb');
    expect(crlf).toBe(`${PASTE_START}a\nb${PASTE_END}\r`);
    const cr = ptyMessagePayload('a\rb');
    expect(cr).toBe(`${PASTE_START}a\nb${PASTE_END}\r`);
    // Only the trailing submit CR survives in each.
    expect(crlf.split('\r')).toHaveLength(2);
    expect(cr.split('\r')).toHaveLength(2);
  });

  it('a single-line message containing a bare CR is treated as multi-line (never submits early)', () => {
    // 'a\rb' normalizes to 'a\nb' -> must be bracketed, not sent as two submits.
    expect(ptyMessagePayload('a\rb')).toContain(PASTE_START);
  });

  it('preserves the text verbatim inside the paste (no trimming of inner content)', () => {
    const body = 'step 1\n\n  indented\n- bullet';
    expect(ptyMessagePayload(body)).toBe(`${PASTE_START}${body}${PASTE_END}\r`);
  });
});

describe('flattenForPty', () => {
  it('passes a string through, trimmed', () => {
    expect(flattenForPty('  hello  ')).toEqual({ text: 'hello', droppedNonText: false });
  });

  it('joins text blocks and reports nothing dropped', () => {
    const blocks = [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }];
    expect(flattenForPty(blocks)).toEqual({ text: 'one\ntwo', droppedNonText: false });
  });

  it('drops non-text blocks (an image cannot be typed into a terminal) and says so', () => {
    const blocks = [{ type: 'text', text: 'look' }, { type: 'image', source: {} } as any];
    expect(flattenForPty(blocks)).toEqual({ text: 'look', droppedNonText: true });
  });

  it('an image-only payload flattens to empty text, flagged as dropped', () => {
    expect(flattenForPty([{ type: 'image' } as any])).toEqual({ text: '', droppedNonText: true });
  });

  it('tolerates a non-array, non-string payload', () => {
    expect(flattenForPty(undefined as any)).toEqual({ text: '', droppedNonText: false });
  });
});
