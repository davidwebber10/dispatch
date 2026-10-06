// The owner-decisions block in an agent's report (decision cards spec 2026-10-06, Unit 3).
import { describe, it, expect } from 'vitest';
import { parseOwnerDecisionsBlock, formatOwnerDecisionsNotice, formatSeqList } from '../../src/overseer/owner-decisions.js';

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

  it('a broken block: no closing fence, bad JSON, not an array', () => {
    expect(parseOwnerDecisionsBlock('Report.\n```owner-decisions\n[{"id":"A"}]')).toEqual({ kind: 'broken', reason: 'the block has no closing fence' });
    const bad = parseOwnerDecisionsBlock(block('[{"id": "A",}]'));
    expect(bad.kind).toBe('broken');
    expect((bad as any).reason).toMatch(/^it is not valid JSON \(.+\)$/);
    expect((bad as any).reason).not.toMatch(/\.\)$/);
    expect(parseOwnerDecisionsBlock(block('{"id":"A"}'))).toEqual({ kind: 'broken', reason: 'it is not a JSON array' });
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
