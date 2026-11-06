import { describe, it, expect } from 'vitest';
import { toConvItems, rowKeyOf, chatIndexOf, splitTool, REPORT_TOOL, NOTE_TOOL } from './convItems';
import type { ConvItem, EndlessMessage } from '../../api/types';

const m = (i: number, kind: EndlessMessage['kind'], text: string, over: Partial<EndlessMessage> = {}): EndlessMessage => ({ i, kind, text, size: text.length, project: null, projectName: null, ref: null, media: [], createdAt: 0, ...over });
const r = (msg: EndlessMessage, ref: string) => ({ ...msg, ref });
const spawnTool = (i: number, name: string) => m(i, 'tool', `mcp__memory__spawn_agent ${JSON.stringify({ project: 'studio', agentType: 'implementer', name, task: 'Fix it' })}`);
const spawnEcho = (i: number, id: string, label: string) => m(i, 'echo', JSON.stringify({ agentId: id, label, project: 'studio', projectId: 's1', folder: '/w/studio' }));

/** The rows Chat draws, the shape the old foldRows returned: a call with the `i` of the result it
 *  pairs with (the toolId renderTimeline pairs by), or a lone message. */
type Shape = [string, number] | [string, number, number | undefined];
function shape(messages: EndlessMessage[]): Shape[] {
  const items = toConvItems(messages);
  const at = (it: ConvItem) => chatIndexOf(it)!.i;
  const kindOf = (it: ConvItem) => (it.toolName === 'mcp__memory__zoom' ? 'recall' : it.toolName === 'mcp__memory__spawn_agent' ? 'started' : 'tool');
  const out: Shape[] = [];
  for (const it of items) {
    if (it.kind === 'tool' && (it.toolName === REPORT_TOOL || it.toolName === NOTE_TOOL)) {
      out.push(['msg', at(it)]); // a report or note rides as a call with no result: still a message row
    } else if (it.kind === 'tool') {
      const res = items.find((x) => x.kind === 'tool-result' && x.toolId === it.toolId);
      out.push([kindOf(it), at(it), res ? at(res) : undefined]);
    } else if (it.kind !== 'tool-result' || !items.some((x) => x.kind === 'tool' && x.toolId === it.toolId)) {
      out.push(['msg', at(it)]);
    }
  }
  return out;
}

describe('toConvItems pairing (the old foldRows cases)', () => {
  it('pairs a run of tools with the run of results after it, in order', () => {
    expect(shape([m(0, 'tool', 'Read {}'), m(1, 'tool', 'Grep {}'), m(2, 'echo', 'A'), m(3, 'echo', 'B')])).toEqual([['tool', 0, 2], ['tool', 1, 3]]);
  });
  it('a tool with no result yet stays alone; the run of 1 is unchanged', () => {
    expect(shape([m(0, 'tool', 'Read {}')])).toEqual([['tool', 0, undefined]]);
    expect(shape([m(0, 'tool', 'Read {}'), m(1, 'echo', 'A'), m(2, 'unii', 'hi')])).toEqual([['tool', 0, 1], ['msg', 2]]);
  });
  it('a spawn_agent call pairs with its result', () => {
    expect(shape([spawnTool(0, 'Fix PR #2'), spawnEcho(1, 't9', 'Fix PR #2')])).toEqual([['started', 0, 1]]);
  });
  it('a run of 2 tools with 1 echo pairs the first and leaves the second alone', () => {
    expect(shape([m(0, 'tool', 'Read {}'), m(1, 'tool', 'Grep {}'), m(2, 'echo', 'A')])).toEqual([['tool', 0, 2], ['tool', 1, undefined]]);
  });
  it('a mixed run keeps the kinds and pairs the echoes in order', () => {
    const rows = shape([m(0, 'tool', 'mcp__memory__zoom {}'), spawnTool(1, 'Fix'), m(2, 'tool', 'Read {}'), m(3, 'echo', 'Z'), spawnEcho(4, 't9', 'Fix'), m(5, 'echo', 'R')]);
    expect(rows).toEqual([['recall', 0, 3], ['started', 1, 4], ['tool', 2, 5]]);
  });
  it('a ref-less run must be consecutive: a gap in i ends it', () => {
    expect(shape([m(0, 'tool', 'Read {}'), m(2, 'tool', 'Grep {}'), m(3, 'echo', 'A'), m(4, 'echo', 'B')])).toEqual([['tool', 0, undefined], ['tool', 2, 3], ['msg', 4]]);
  });
});

describe('toConvItems pairing by tool-call id', () => {
  it('pairs a call with its result across a message logged between them', () => {
    const work = { ...m(1, 'work', '[Fix] report: done'), ref: 't9' };
    expect(shape([r(spawnTool(0, 'Fix'), 'A'), work, r(spawnEcho(2, 't9', 'Fix'), 'A')])).toEqual([['started', 0, 2], ['msg', 1]]);
  });
  it('a parallel spawn with a missing result does not shift the others', () => {
    expect(shape([r(spawnTool(0, 'One'), 'A'), r(spawnTool(1, 'Two'), 'B'), r(spawnEcho(2, 't2', 'Two'), 'B')])).toEqual([['started', 0, undefined], ['started', 1, 2]]);
  });
  it('results in reverse order pair by id', () => {
    expect(shape([r(m(0, 'tool', 'Read {}'), 'A'), r(m(1, 'tool', 'Grep {}'), 'B'), r(m(2, 'echo', 'rb'), 'B'), r(m(3, 'echo', 'ra'), 'A')])).toEqual([['tool', 0, 3], ['tool', 1, 2]]);
  });
  it('a result whose call is not loaded is a lone row; ref-less rows keep positional pairing', () => {
    expect(shape([r(m(0, 'echo', 'x'), 'Z')])).toEqual([['msg', 0]]);
    expect(shape([m(0, 'tool', 'Read {}'), m(1, 'echo', 'A')])).toEqual([['tool', 0, 1]]);
  });
  it('a ref-carrying call never pairs positionally with a ref-less result', () => {
    expect(shape([r(m(0, 'tool', 'Read {}'), 'A'), m(1, 'echo', 'old')])).toEqual([['tool', 0, undefined], ['msg', 1]]);
  });
  it('two calls with the same ref take their results oldest first', () => {
    expect(shape([r(m(0, 'tool', 'Read {}'), 'A'), r(m(1, 'tool', 'Read {}'), 'A'), r(m(2, 'echo', 'x'), 'A'), r(m(3, 'echo', 'y'), 'A')])).toEqual([['tool', 0, 2], ['tool', 1, 3]]);
  });
});

describe('rowKeyOf', () => {
  it('maps an echo paired by id to its tool, and anything else to itself', () => {
    const msgs = [r(m(0, 'tool', 'Read {}'), 'A'), m(1, 'unii', 'hi'), r(m(2, 'echo', 'ra'), 'A')];
    expect(rowKeyOf(msgs, 2)).toBe(0);
    expect(rowKeyOf(msgs, 1)).toBe(1);
    expect(rowKeyOf(msgs, 0)).toBe(0);
  });
  it('a lone result is its own row; a message not loaded has none', () => {
    expect(rowKeyOf([r(m(4, 'echo', 'x'), 'Z')], 4)).toBe(4);
    expect(rowKeyOf([m(0, 'unii', 'hi')], 9)).toBeNull();
  });
});

describe('toConvItems items', () => {
  it('each kind maps to the item the thread view draws, with stable ids from i', () => {
    const items = toConvItems([
      m(0, 'user', 'hello', { project: 's1', projectName: 'studio' }),
      m(1, 'unii', 'hi there'),
      m(2, 'tool', 'Bash {"command":"ls"}'),
      m(3, 'echo', 'a.txt'),
      m(4, 'work', '[Fix] report: done'),
      m(5, 'note', 'memories'),
    ]);
    expect(items).toEqual([
      { kind: 'user', text: 'hello', uuid: 'e0' },
      { kind: 'assistant', text: 'hi there', uuid: 'e1' },
      { kind: 'tool', toolName: 'Bash', toolInput: '{"command":"ls"}', toolId: 'chat:t2', uuid: 'e2' },
      { kind: 'tool-result', text: 'a.txt', toolId: 'chat:t2', uuid: 'e3' },
      { kind: 'tool', toolName: REPORT_TOOL, toolId: 'chat:t4', text: '[Fix] report: done', uuid: 'e4' },
      { kind: 'tool', toolName: NOTE_TOOL, toolId: 'chat:t5', text: 'memories', uuid: 'e5' },
    ]);
  });
  it('a lone result gets an id no call has, so it draws on its own', () => {
    expect(toConvItems([m(7, 'echo', 'x')])[0]).toMatchObject({ kind: 'tool-result', toolId: 'chat:r7' });
  });
  it("a user message's images become user images after its bubble; other files stay with the bubble", () => {
    const items = toConvItems([m(3, 'user', 'look', { media: ['1-0-abcdef12-a.png', '1-1-abcdef12-notes.pdf', '1-2-abcdef12-b.JPG'] })]);
    expect(items.map((x) => [x.kind, x.uuid, x.imageFromUser])).toEqual([['user', 'e3', undefined], ['image', 'e3:0', true], ['image', 'e3:1', true]]);
    expect(items[1].imageUrl).toContain('a.png');
    expect(items[2].imageUrl).toContain('b.JPG');
    expect(chatIndexOf(items[2])).toEqual({ i: 3, piece: 1 });
    expect(chatIndexOf(items[0])).toEqual({ i: 3, piece: null });
  });
  it('an unchanged message gives back the same item objects (renderTimeline tracks pages by identity)', () => {
    const msgs = [m(0, 'unii', 'a'), m(1, 'tool', 'Read {}')];
    const first = toConvItems(msgs);
    const echo = m(2, 'echo', 'out');
    const second = toConvItems([...msgs, echo]);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    // An echo whose pairing changes is rebuilt with its new id.
    const lone = toConvItems([echo]);
    expect(lone[0].toolId).toBe('chat:r2');
    expect(second[2].toolId).toBe('chat:t1');
  });
  it('splitTool takes the name before the first space', () => {
    expect(splitTool('Read {"file_path":"/a b"}')).toEqual({ name: 'Read', input: '{"file_path":"/a b"}' });
    expect(splitTool('Read')).toEqual({ name: 'Read', input: '' });
  });
  it('a negative i (an older page) keeps its id', () => {
    expect(chatIndexOf(toConvItems([m(-1, 'unii', 'older')])[0])).toEqual({ i: -1, piece: null });
  });
});

describe('a call whose result was never logged (2026-11-05)', () => {
  const plain = (items: ConvItem[]) => items.map((it) => `${it.kind}:${it.toolId ?? ''}:${it.text ?? ''}`);

  it('once the conversation has moved past it, it gets a stand-in result, so it does not read "running…"', () => {
    const items = toConvItems([m(1, 'tool', 'Bash {"command":"ls"}'), m(2, 'unii', 'done')]);
    expect(plain(items)).toEqual(['tool:chat:t1:', 'tool-result:chat:t1:(no output recorded)', 'assistant::done']);
  });

  it('the newest call, with nothing after it, is still running', () => {
    const items = toConvItems([m(1, 'user', 'go'), m(2, 'tool', 'Bash {"command":"ls"}')]);
    expect(items.some((it) => it.kind === 'tool-result')).toBe(false);
  });

  it('Chat\'s own cards (recalled, Started) are left to handle a missing result themselves', () => {
    const items = toConvItems([m(1, 'tool', 'mcp__memory__zoom {"i":3}'), spawnTool(2, 'Fixer'), m(3, 'unii', 'ok')]);
    expect(items.some((it) => it.kind === 'tool-result')).toBe(false);
  });

  it('the stand-in keeps its identity across renders', () => {
    const msgs = [m(1, 'tool', 'Bash {}'), m(2, 'user', 'next')];
    expect(toConvItems(msgs)[1]).toBe(toConvItems(msgs)[1]);
  });
});
