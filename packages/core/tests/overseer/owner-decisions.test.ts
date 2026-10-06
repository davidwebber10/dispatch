// The owner-decisions block in an agent's report (decision cards spec 2026-10-06, Unit 3).
import { describe, it, expect } from 'vitest';
import {
  parseOwnerDecisionsBlock, formatOwnerDecisionsNotice, formatSeqList, MAX_BLOCK_BYTES, MAX_BLOCK_ENTRIES,
} from '../../src/overseer/owner-decisions.js';

const block = (body: string, fence = '```') => `Report text.\n\n${fence}owner-decisions\n${body}\n${fence}\n`;

describe('parseOwnerDecisionsBlock', () => {
  it('no block: none', () => {
    expect(parseOwnerDecisionsBlock('All done. No decisions for the owner.')).toEqual({ kind: 'none' });
    expect(parseOwnerDecisionsBlock('```json\n[]\n```')).toEqual({ kind: 'none' });
  });

  it('a valid block: its entries', () => {
    expect(parseOwnerDecisionsBlock(block('[{"id":"LR-6","question":"How many nights?"}]'))).toEqual({
      kind: 'ok', entries: [{ id: 'LR-6', question: 'How many nights?' }],
    });
    expect(parseOwnerDecisionsBlock(block('[]'))).toEqual({ kind: 'ok', entries: [] });
  });

  it('the last block in the message wins; a longer fence and a tilde fence work', () => {
    const text = `${block('[{"id":"A"}]')}\nCorrected:\n${block('[{"id":"B"}]', '````')}`;
    expect(parseOwnerDecisionsBlock(text)).toEqual({ kind: 'ok', entries: [{ id: 'B' }] });
    expect(parseOwnerDecisionsBlock(block('[{"id":"C"}]', '~~~'))).toEqual({ kind: 'ok', entries: [{ id: 'C' }] });
  });

  it('a fence inside a JSON string does not close the block early', () => {
    expect(parseOwnerDecisionsBlock(block('[{"id":"A","context":"see ``` above"}]'))).toEqual({
      kind: 'ok', entries: [{ id: 'A', context: 'see ``` above' }],
    });
  });

  it('a quoted example is content, not a block: the spec\'s own form (a four-backtick text fence around it)', () => {
    const quoted = 'Use this form:\n\n````text\n```owner-decisions\n[{"id":"LR-6"}]\n```\n````\n\nDone.';
    expect(parseOwnerDecisionsBlock(quoted)).toEqual({ kind: 'none' });
    // A tilde fence of 3 does not close a backtick fence, and a shorter fence does not close a longer one.
    expect(parseOwnerDecisionsBlock('~~~~md\n~~~\n```owner-decisions\n[{"id":"A"}]\n```\n~~~~\n')).toEqual({ kind: 'none' });
    expect(parseOwnerDecisionsBlock('`````\n````\n```owner-decisions\n[{"id":"A"}]\n```\n`````\n')).toEqual({ kind: 'none' });
  });

  it('a block indented 4 or more spaces is content (an indented code block)', () => {
    expect(parseOwnerDecisionsBlock('Example:\n\n    ```owner-decisions\n    [{"id":"A"}]\n    ```\n')).toEqual({ kind: 'none' });
    expect(parseOwnerDecisionsBlock('   ```owner-decisions\n[{"id":"A"}]\n   ```\n')).toEqual({ kind: 'ok', entries: [{ id: 'A' }] });
  });

  it('a real top-level block after a quoted one is still found; the last top-level block wins', () => {
    const quoted = '````text\n```owner-decisions\n[{"id":"QUOTED"}]\n```\n````';
    expect(parseOwnerDecisionsBlock(`${quoted}\n\n${block('[{"id":"REAL"}]')}`)).toEqual({ kind: 'ok', entries: [{ id: 'REAL' }] });
    expect(parseOwnerDecisionsBlock(`${block('[{"id":"REAL"}]')}\n${quoted}\n`)).toEqual({ kind: 'ok', entries: [{ id: 'REAL' }] });
  });

  it('a broken block: no closing fence, bad JSON, not an array', () => {
    expect(parseOwnerDecisionsBlock('Report.\n```owner-decisions\n[{"id":"A"}]')).toEqual({ kind: 'broken', reason: 'the block has no closing fence' });
    const bad = parseOwnerDecisionsBlock(block('[{"id": "A",}]'));
    expect(bad.kind).toBe('broken');
    expect((bad as any).reason).toMatch(/^it is not valid JSON \(.+\)$/);
    expect((bad as any).reason).not.toMatch(/\.\)$/);
    expect(parseOwnerDecisionsBlock(block('{"id":"A"}'))).toEqual({ kind: 'broken', reason: 'it is not a JSON array' });
  });

  it('size limits: 50 entries and 64 KB of text pass; one more entry or one more byte is a broken block', () => {
    const entries = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `D${i + 1}` })));
    expect(MAX_BLOCK_ENTRIES).toBe(50);
    expect(MAX_BLOCK_BYTES).toBe(64 * 1024);
    expect((parseOwnerDecisionsBlock(block(entries(50))) as any).entries).toHaveLength(50);
    expect(parseOwnerDecisionsBlock(block(entries(73)))).toEqual({ kind: 'broken', reason: 'the block has 73 entries; the limit is 50' });
    expect(parseOwnerDecisionsBlock(block(entries(51)))).toEqual({ kind: 'broken', reason: 'the block has 51 entries; the limit is 50' });
    // A body of exactly 64 KB: a JSON array whose one string fills the rest. "é" is 2 bytes in UTF-8.
    const body = (bytes: number) => { const head = '[{"id":"A","context":"'; const tail = '"}]'; return head + 'x'.repeat(bytes - head.length - tail.length) + tail; };
    expect(parseOwnerDecisionsBlock(block(body(MAX_BLOCK_BYTES))).kind).toBe('ok');
    expect(parseOwnerDecisionsBlock(block(body(MAX_BLOCK_BYTES + 1)))).toEqual({ kind: 'broken', reason: 'the block has 65537 bytes of text; the limit is 65536 (64 KB)' });
    // Bytes, not characters: 65536 characters with one 2-byte "é" are 65537 bytes.
    expect(parseOwnerDecisionsBlock(block(body(MAX_BLOCK_BYTES).replace('x', 'é')))).toEqual({ kind: 'broken', reason: 'the block has 65537 bytes of text; the limit is 65536 (64 KB)' });
  });

  it('the size limit counts the original text, so CRLF line ends count as 2 bytes each', () => {
    // 40,000 CRLF padding lines: 40 KB after line ends are normalized, but 80 KB as sent.
    const raw = '[\r\n' + '\r\n'.repeat(40_000) + '{"id":"A"}]';
    const bytes = Buffer.byteLength(raw, 'utf8');
    expect(bytes).toBeGreaterThan(MAX_BLOCK_BYTES);
    expect(Buffer.byteLength(raw.replace(/\r\n/g, '\n'), 'utf8')).toBeLessThan(MAX_BLOCK_BYTES);
    expect(parseOwnerDecisionsBlock(block(raw))).toEqual({ kind: 'broken', reason: `the block has ${bytes} bytes of text; the limit is 65536 (64 KB)` });
    // The same padding with LF line ends stays under the limit and parses.
    expect(parseOwnerDecisionsBlock(block(raw.replace(/\r\n/g, '\n'))).kind).toBe('ok');
  });
});

describe('formatSeqList', () => {
  it('one ID, two IDs, a run of three or more, and a list with gaps', () => {
    expect(formatSeqList([30])).toBe('N30');
    expect(formatSeqList([30, 31])).toBe('N30, N31');
    expect(formatSeqList([30, 31, 32, 33, 34, 35, 36])).toBe('N30 to N36');
    expect(formatSeqList([30, 32, 33])).toBe('N30, N32, N33');
  });
});

describe('formatOwnerDecisionsNotice', () => {
  it('the count line, word for word', () => {
    expect(formatOwnerDecisionsNotice({ kind: 'captured', created: [30, 31, 32, 33, 34, 35, 36], skipped: [] })).toEqual([
      'This report has 7 owner decisions (N30 to N36). Triage each now: ledger_add_from_agent sends it to the user; ledger_decide_self records your own choice.',
    ]);
    expect(formatOwnerDecisionsNotice({ kind: 'captured', created: [4], skipped: [] })).toEqual([
      'This report has 1 owner decision (N4). Triage each now: ledger_add_from_agent sends it to the user; ledger_decide_self records your own choice.',
    ]);
  });

  it('names each invalid entry by its id and the failed check', () => {
    expect(formatOwnerDecisionsNotice({
      kind: 'captured', created: [], skipped: [{ id: 'LR-7', reason: 'A decision card needs: why. Add them and try again.' }],
    })).toEqual(['Skipped owner decision LR-7: A decision card needs: why. Add them and try again.']);
  });

  it('a broken block, word for word; nothing for no block or only unchanged repeats', () => {
    expect(formatOwnerDecisionsNotice({ kind: 'broken', reason: 'it is not a JSON array' })).toEqual([
      'The owner-decisions block could not be read: it is not a JSON array. Ask the agent to fix it.',
    ]);
    expect(formatOwnerDecisionsNotice({ kind: 'none' })).toEqual([]);
    expect(formatOwnerDecisionsNotice({ kind: 'captured', created: [], skipped: [] })).toEqual([]);
  });
});
