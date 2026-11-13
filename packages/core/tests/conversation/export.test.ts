import { describe, it, expect } from 'vitest';
import { renderThreadMarkdown, exportFileName, collectAllItems, toolLine } from '../../src/conversation/export.js';
import type { ConvItem } from '../../src/conversation/transcript.js';

// Owner, 2026-11-13: "a Download Thread button: output the whole conversation as a file that I could throw
// into any unrelated model to pass context".
const META = { label: 'Fix login', project: 'Storefront', tool: 'Claude Code', model: 'opus', folder: '/w/store', startedAt: '2026-11-10T09:00:00Z', lastActivityAt: '2026-11-13T10:00:00Z', exportedAt: '2026-11-13T12:00:00Z' };

describe('renderThreadMarkdown', () => {
  const items: ConvItem[] = [
    { kind: 'user', text: 'The login fails on Safari.' },
    { kind: 'thinking', text: 'secret reasoning' },
    { kind: 'assistant', text: 'I look at the cookie code.' },
    { kind: 'tool', toolName: 'Bash', toolInput: JSON.stringify({ command: 'npm test -- login' }) },
    { kind: 'tool-result', text: 'PASS 12 tests\n'.repeat(50) },
    { kind: 'tool', toolName: 'Edit', toolInput: JSON.stringify({ file_path: '/w/store/src/auth.ts', old_string: 'a', new_string: 'b' }) },
    { kind: 'assistant', text: 'Fixed: SameSite was wrong.' },
    { kind: 'notice', text: 'Background task finished' },
    { kind: 'image', imageUrl: 'data:image/png;base64,AAAA', imageFromUser: true } as ConvItem,
    { kind: 'user', text: 'Thanks.' },
  ];
  const md = renderThreadMarkdown(META, items);

  it('starts with the title, the facts and the line that says what follows', () => {
    expect(md.startsWith('# Fix login\n')).toBe(true);
    for (const s of ['Project: Storefront', 'Tool: Claude Code', 'Model: opus', 'Folder: /w/store', 'Started: 2026-11-10', 'Exported at: 2026-11-13']) expect(md).toContain(s);
    expect(md).toContain('Tool calls are listed as one line each, without their output.');
  });

  it('keeps the order, merges the assistant text of one turn, and lists each tool call on one line', () => {
    const body = md.slice(md.indexOf('## You'));
    expect(body.indexOf('The login fails')).toBeLessThan(body.indexOf('I look at the cookie'));
    expect(body.indexOf('Fixed: SameSite')).toBeLessThan(body.indexOf('Thanks.'));
    expect(body.match(/## Assistant/g)).toHaveLength(1); // one turn, one section
    expect(body).toContain('→ Bash: npm test -- login');
    expect(body).toContain('→ Edit: /w/store/src/auth.ts');
  });

  it('leaves out thinking, tool output, notices and image data', () => {
    expect(md).not.toContain('secret reasoning');
    expect(md).not.toContain('PASS 12 tests');
    expect(md).not.toContain('Background task finished');
    expect(md).not.toContain('base64');
    expect(md).toContain('[image]');
  });

  it('says so when the thread has no messages', () => {
    expect(renderThreadMarkdown(META, [])).toContain('No messages yet.');
  });

  it('stops at the size cap and says it was cut', () => {
    const big: ConvItem[] = Array.from({ length: 200 }, (_, i) => ({ kind: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(1000) }) as ConvItem);
    const out = renderThreadMarkdown(META, big, { maxBytes: 20_000 });
    expect(Buffer.byteLength(out)).toBeLessThan(23_000);
    expect(out.trimEnd().endsWith('[The export was cut here: the conversation is longer than the file limit.]')).toBe(true);
  });
});

describe('toolLine', () => {
  const t = (toolName: string, input: unknown, extra: Partial<ConvItem> = {}) => toolLine({ kind: 'tool', toolName, toolInput: JSON.stringify(input), ...extra });
  it('names the most telling input of each tool, on one short line', () => {
    expect(t('Read', { file_path: '/a/b.ts' })).toBe('→ Read: /a/b.ts');
    expect(t('Grep', { pattern: 'TODO', path: '/a' })).toBe('→ Grep: TODO');
    expect(t('WebFetch', { url: 'https://x.y/z', prompt: 'p' })).toBe('→ WebFetch: https://x.y/z');
    expect(t('mcp__dispatch__message_thread', { id: 't1', text: 'hello\nthere' })).toBe('→ mcp__dispatch__message_thread: t1');
    expect(t('Bash', { command: 'a\n  b' })).toBe('→ Bash: a b');
    expect(t('Bash', { command: 'y'.repeat(400) }).length).toBeLessThanOrEqual(175);
    expect(toolLine({ kind: 'tool', toolName: 'Task' })).toBe('→ Task');
  });
});

describe('exportFileName and collectAllItems', () => {
  it('makes a safe file name from the label and the date', () => {
    expect(exportFileName('Fix login: Safari / cookies!', '2026-11-13T12:00:00Z')).toBe('Fix-login-Safari-cookies-2026-11-13.md');
    expect(exportFileName('', '2026-11-13T12:00:00Z')).toBe('thread-2026-11-13.md');
    expect(exportFileName('日本語のスレッド', '2026-11-13T12:00:00Z')).toBe('thread-2026-11-13.md');
    expect(exportFileName('Café notes', '2026-11-13T12:00:00Z')).toBe('Cafe-notes-2026-11-13.md');
  });

  it('reads every page from the newest back to the oldest and returns them oldest first', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => ({ kind: 'user', text: `m${i}` }) as ConvItem);
    const page = async (o: { before?: number; limit?: number }) => {
      const end = o.before ?? 25; const start = Math.max(0, end - (o.limit ?? 10));
      return { items: lines.slice(start, end), cursor: 25, startLine: start, hasMore: start > 0 };
    };
    const all = await collectAllItems(page, { pageSize: 10 });
    expect(all.map((i) => i.text)).toEqual(lines.map((i) => i.text));
  });
});
