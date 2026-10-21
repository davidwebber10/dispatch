import { test, expect } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { createWriteGate, suppressReplayedQueries } from './replayQueries';

// These tests drive the REAL xterm parser, because what xterm answers on its own is exactly
// what has to be matched here. A fake parser would only prove the fake.
// jsdom has no matchMedia, which xterm's open() reads.
if (!window.matchMedia) window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as any;

function setup() {
  const term = new Terminal({ cols: 80, rows: 24, theme: { background: '#1E1E1E' } });
  // Opened, because only an opened terminal answers the colour queries (the colour service lives there).
  term.open(document.createElement('div'));
  const replies: string[] = [];
  term.onData((d) => replies.push(d));
  const gate = createWriteGate(term);
  suppressReplayedQueries(term, gate.parsingReplay);
  const write = (chunk: string, replay: boolean) => new Promise<void>((res) => gate.write(chunk, replay, res));
  return { term, replies, gate, write };
}

const ESC = '\x1b';
const BEL = '\x07';
// Every query xterm 5.5 answers on its own, with the reply it would send.
const QUERIES: Record<string, string> = {
  'OSC 10 fg': `${ESC}]10;?${BEL}`,
  'OSC 11 bg': `${ESC}]11;?${BEL}`,
  'OSC 11 bg, ST end': `${ESC}]11;?${ESC}\\`,
  'OSC 12 cursor': `${ESC}]12;?${BEL}`,
  'OSC 10 two slots': `${ESC}]10;?;?${BEL}`,
  'OSC 4 palette': `${ESC}]4;1;?${BEL}`,
  'OSC 4 two entries': `${ESC}]4;1;?;2;?${BEL}`,
  // A set and a query in one sequence: xterm applies the set AND answers the query.
  'OSC 10 set then query': `${ESC}]10;#ff0000;?${BEL}`,
  'OSC 4 set then query': `${ESC}]4;1;#ff0000;2;?${BEL}`,
  'DSR 5n': `${ESC}[5n`,
  'CPR 6n': `${ESC}[6n`,
  'DECXCPR ?6n': `${ESC}[?6n`,
  'DA1': `${ESC}[c`,
  'DA1 with 0': `${ESC}[0c`,
  'DA2': `${ESC}[>c`,
  'DECRQM ?2004': `${ESC}[?2004$p`,
  'DECRQM ansi 4': `${ESC}[4$p`,
  'DECRQSS': `${ESC}P$qm${ESC}\\`,
};

test('every query is answered by xterm when it arrives live (so the list above is real)', async () => {
  for (const [name, q] of Object.entries(QUERIES)) {
    const { replies, write } = setup();
    await write(`hi${q}`, false);
    expect(replies.length, name).toBeGreaterThan(0);
  }
});

test('no query is answered while its own write is a replay', async () => {
  for (const [name, q] of Object.entries(QUERIES)) {
    const { replies, write } = setup();
    await write(`hi${q}there`, true);
    expect(replies, name).toEqual([]);
  }
});

test('a query split across two replay frames is still suppressed', async () => {
  const { replies, write } = setup();
  const p1 = write(`a${ESC}]11;`, true);
  const p2 = write(`?${BEL}b`, true);
  await Promise.all([p1, p2]);
  expect(replies).toEqual([]);
});

test('settings sequences that are not queries still take effect during a replay', async () => {
  const { term, replies, write } = setup();
  await write(`${ESC}[2;5H${ESC}[6n`, true);
  expect(replies).toEqual([]);
  expect(term.buffer.active.cursorY).toBe(1);
  expect(term.buffer.active.cursorX).toBe(4);
});

test('a live query queued BEFORE a replay is answered, though the replay is already queued', async () => {
  const { replies, write } = setup();
  const live = write(`${ESC}[6n`, false);
  const replay = write(`old${ESC}[6n`, true);
  await Promise.all([live, replay]);
  expect(replies).toHaveLength(1);
});

test('replay A, live query, replay B: only the live query is answered', async () => {
  const { replies, write } = setup();
  await Promise.all([
    write(`${ESC}]11;?${BEL}`, true),
    write(`${ESC}]11;?${BEL}`, false),
    write(`${ESC}]11;?${BEL}`, true),
  ]);
  expect(replies).toHaveLength(1);
});

test('a live query right after a replay is answered', async () => {
  const { replies, write } = setup();
  await write(`${ESC}[6n`, true);
  await write(`${ESC}[6n`, false);
  expect(replies).toHaveLength(1);
});

test('term.reset() between queued writes does not strand the gate', async () => {
  const { term, replies, gate, write } = setup();
  const first = write(`${ESC}[6n`, true);
  term.reset();
  const second = write(`${ESC}[6n`, false);
  await Promise.all([first, second]);
  expect(gate.parsingReplay()).toBe(false);
  expect(replies).toHaveLength(1);
});

test('typed input is never filtered', async () => {
  const { term, replies, write } = setup();
  const p = write(`${ESC}[6n`, true);
  (term as any).input('ls\r', true);
  await p;
  expect(replies).toContain('ls\r');
});
