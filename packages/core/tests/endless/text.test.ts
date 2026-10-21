import { describe, it, expect } from 'vitest';
import { byteLength, cutBytes, clipToolOutput, splitLongText, oneLine, messageLine, TOOL_CLIP_CHARS } from '../../src/endless/text.js';

const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const noBrokenPair = (s: string) => {
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (isHigh(c) && !isLow(s.charCodeAt(k + 1))) return false;
    if (isLow(c) && !isHigh(s.charCodeAt(k - 1))) return false;
  }
  return true;
};

describe('byteLength', () => {
  it('counts UTF-8 bytes, not characters', () => {
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('é')).toBe(2);
    expect(byteLength('€')).toBe(3);
    expect(byteLength('😀')).toBe(4);
  });
});

describe('cutBytes', () => {
  it('returns the text when it fits', () => {
    expect(cutBytes('hello', 512)).toBe('hello');
  });
  it('cutBytes never splits a UTF-8 sequence', () => {
    const text = '€'.repeat(200); // 600 bytes, 3 per char
    const cut = cutBytes(text, 512);
    expect(byteLength(cut)).toBe(510);
    expect(cut).not.toContain('�');
    expect(cutBytes('a😀', 3)).toBe('a');
  });
});

describe('clipToolOutput', () => {
  it('keeps short output whole', () => {
    expect(clipToolOutput('ok')).toBe('ok');
  });
  it('clips head + tail to 30,000 characters total', () => {
    const text = 'H'.repeat(40_000) + 'T'.repeat(40_000);
    const out = clipToolOutput(text);
    expect(out.length).toBeLessThanOrEqual(TOOL_CLIP_CHARS);
    expect(out.startsWith('HHHH')).toBe(true);
    expect(out.endsWith('TTTT')).toBe(true);
    expect(out).toMatch(/characters clipped/);
  });
  it('clipToolOutput keeps surrogate pairs whole', () => {
    const text = '😀'.repeat(30_000); // 60,000 UTF-16 units
    const out = clipToolOutput(text);
    expect(out.length).toBeLessThanOrEqual(TOOL_CLIP_CHARS);
    expect(noBrokenPair(out)).toBe(true);
  });
  it('clipToolOutput never cuts inside a pair when the pairs start at an odd offset', () => {
    const text = 'a' + '😀'.repeat(30_000); // pairs at odd offsets, so the cut guards must fire
    const out = clipToolOutput(text);
    expect(out.length).toBeLessThanOrEqual(TOOL_CLIP_CHARS);
    expect(noBrokenPair(out)).toBe(true);
    expect(isHigh(out.charCodeAt(out.length - 1))).toBe(false);
    expect(out.startsWith('a')).toBe(true);
  });
});

describe('splitLongText', () => {
  it('keeps text under the limit as one piece', () => {
    expect(splitLongText('short')).toEqual(['short']);
  });
  it('splits a 200 KB text into pieces of at most 30,000 chars that join back exactly', () => {
    const text = Array.from({ length: 4000 }, (_, k) => `line ${k} ${'x'.repeat(40)}`).join('\n'); // ~200 KB
    const pieces = splitLongText(text);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(30_000);
    expect(pieces.join('')).toBe(text);
  });
  it('never splits a surrogate pair', () => {
    const text = '😀'.repeat(40_000);
    const pieces = splitLongText(text);
    expect(pieces.join('')).toBe(text);
    for (const p of pieces) expect(noBrokenPair(p)).toBe(true);
  });
  it('splitLongText never splits inside a pair when the pairs start at an odd offset', () => {
    const text = 'a' + '😀'.repeat(40_000); // pairs at odd offsets, so the cut guards must fire
    const pieces = splitLongText(text);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join('')).toBe(text);
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(30_000);
      expect(isHigh(p.charCodeAt(p.length - 1))).toBe(false);
      expect(isLow(p.charCodeAt(0))).toBe(false);
      expect(noBrokenPair(p)).toBe(true);
    }
  });
});

describe('oneLine and messageLine', () => {
  it('turns newlines into spaces', () => {
    expect(oneLine('a\nb\r\nc\rd')).toBe('a b c d');
  });
  it('renders kind, optional project, and text', () => {
    expect(messageLine('user', 'hi', 'salsify')).toBe('user (salsify): hi');
    expect(messageLine('unii', 'ok', null)).toBe('unii: ok');
  });
});
