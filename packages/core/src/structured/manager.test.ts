// packages/core/src/structured/manager.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksLikeQuestion } from '../status/question.js';
import { ClaudeStructuredSessionManager, turnTextsFromEvents } from './manager.js';

describe('looksLikeQuestion wiring contract', () => {
  it('is the backstop the manager uses for an undeclared question turn', () => {
    expect(looksLikeQuestion('Rewired the rail. Does that look right?')).toBe(true);
    expect(looksLikeQuestion('Rewired the rail. All tests pass.')).toBe(false);
  });
});

// The complete texts of the last turn, for the owner-decisions capture (decision cards, Unit 3).
describe('turnTextsFromEvents — the Claude ring', () => {
  const fixture = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/claude-stream.jsonl'), 'utf8',
  ).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const text = (t: string, parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text: t }] } });
  const result = { type: 'result', subtype: 'success', is_error: false };

  it('a real stream: every main-agent text of the turn, oldest first, in full', () => {
    const texts = turnTextsFromEvents(fixture);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe("I'll create the file and then verify it exists.");
    expect(texts[1].startsWith('Done — `hello.txt` was created and verified.')).toBe(true);
  });

  it('only the last ended turn: it stops at the turn before, and a running turn is not read', () => {
    expect(turnTextsFromEvents([text('old report'), result, text('new report'), text('Done.'), result])).toEqual(['new report', 'Done.']);
    expect(turnTextsFromEvents([text('old report'), result, text('still running')])).toEqual(['old report']);
    expect(turnTextsFromEvents([text('no result yet')])).toEqual([]);
    expect(turnTextsFromEvents([])).toEqual([]);
  });

  it('a sub-agent\'s text (parent_tool_use_id set) is never the agent\'s own', () => {
    expect(turnTextsFromEvents([result, text('sub-agent report', 'toolu_01'), text('My report.'), result])).toEqual(['My report.']);
  });

  it('the manager reads its own ring, and null for a terminal it does not run', () => {
    expect(new ClaudeStructuredSessionManager().getTurnTexts('nope')).toBeNull();
  });
});
