import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENDLESS_SYSTEM_PROMPT, RULER, systemPromptWith, compressTask, mergeTask, tooLongText } from '../../src/endless/prompt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = fs.readFileSync(path.join(here, '../../../../docs/superpowers/specs/2026-10-13-endless-chat-design.md'), 'utf8');

describe('fixed texts', () => {
  it('the system prompt is Appendix A verbatim', () => {
    const appendix = spec.slice(spec.indexOf('## Appendix A'));
    const start = appendix.indexOf('```\n') + 4;
    const end = appendix.indexOf('\n```', start);
    expect(ENDLESS_SYSTEM_PROMPT).toBe(appendix.slice(start, end));
  });
  it('names what the thread and ledger tools really do', () => {
    const flat = ENDLESS_SYSTEM_PROMPT.replace(/\s+/g, ' ');
    expect(flat).toContain('message_thread steers a thread you started');
    expect(flat).toContain("the ledger_ tools read, add, withdraw and retitle a project's open items");
    expect(flat).not.toContain('steers any thread');
  });
  it('holds no date or state', () => {
    expect(ENDLESS_SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(systemPromptWith('  ')).toBe(ENDLESS_SYSTEM_PROMPT);
    expect(systemPromptWith('I am David.')).toBe(`${ENDLESS_SYSTEM_PROMPT}\n\nI am David.`);
  });
  it('the ruler is 512 dashes', () => {
    expect(RULER).toBe('-'.repeat(512));
  });
  it('renders the gist task texts', () => {
    expect(compressTask(7, 'user: hi')).toBe(
      `Compaction: compress message 7 into one line of at most 512 bytes\n(about 70 words), the length of this ruler:\n${RULER}\n<input>\nuser: hi\n</input>`,
    );
    expect(mergeTask('0+2', '2+2', 0, 3, '0+2|a', '2+2|b')).toBe(
      `Compaction: merge lines 0+2 and 2+2, adjacent, into one line of at most\n512 bytes (about 70 words), the length of this ruler:\n${RULER}\n<chat> may hold their messages, 0 to 3, in more detail: take details\nof them from there too.\n<input>\n0+2|a\n2+2|b\n</input>`,
    );
    expect(tooLongText(600, 'abc')).toBe(
      'Too long: your line is 600 bytes, over the 512-byte limit. Write\nthe whole line again for the same <input>, cutting just enough of the\nleast valuable items to fit before this cut:\nabc| ← LIMIT',
    );
  });
});
