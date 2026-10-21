import type { Terminal } from '@xterm/xterm';

// A replayed ring buffer holds every terminal query the CLI ever sent (colours, cursor position,
// device attributes). xterm answers each one on its own, but the CLI consumed those answers long
// ago, so a second answer arrives as typed text. This module keeps xterm from answering a query
// while it parses REPLAYED bytes. A live query is answered as always.

type Writer = Pick<Terminal, 'write'>;

/** Writes go through the gate so we know, at parse time, whether the write xterm is parsing
 *  right now is a replay. xterm parses writes in order and fires each callback right after its
 *  chunk, so the oldest write without a callback is the one being parsed. A plain counter
 *  bumped at enqueue time gets this wrong when a live write is queued next to a replay. */
export function createWriteGate(term: Writer) {
  const queue: boolean[] = [];
  return {
    write(chunk: string, replay: boolean, cb?: () => void) {
      queue.push(replay);
      term.write(chunk, () => { queue.shift(); cb?.(); });
    },
    parsingReplay: () => queue[0] === true,
  };
}

type Params = (number | number[])[];
const isQuery0 = (p: Params) => !(Number(p[0]) > 0);

/** Registers handlers, ahead of xterm's own, that swallow the queries xterm 5.5 answers by
 *  itself while `parsingReplay()` is true. Returns a function that removes them. A colour
 *  sequence that only sets values is left alone. */
export function suppressReplayedQueries(term: Pick<Terminal, 'parser'>, parsingReplay: () => boolean): () => void {
  const p = term.parser;
  const csi = (id: { prefix?: string; intermediates?: string; final: string }, isQuery: (params: Params) => boolean) =>
    p.registerCsiHandler(id, (params) => parsingReplay() && isQuery(params));
  const osc = (ident: number, isQuery: (parts: string[]) => boolean) =>
    p.registerOscHandler(ident, (data) => parsingReplay() && isQuery(data.split(';')));

  // A sequence with ANY query slot makes xterm answer it, even when other slots set a colour, so
  // it is dropped whole during a replay (a replayed colour change is lost with it, a stale reply
  // is worse). OSC 4 is "index;spec" pairs, so only the odd slots can be a query.
  const anyQuestion = (parts: string[]) => parts.includes('?');
  const paletteQuery = (parts: string[]) => parts.some((s, i) => i % 2 === 1 && s === '?');

  const handlers = [
    csi({ final: 'n' }, (a) => a[0] === 5 || a[0] === 6),
    csi({ prefix: '?', final: 'n' }, (a) => a[0] === 6),
    csi({ final: 'c' }, isQuery0),
    csi({ prefix: '>', final: 'c' }, isQuery0),
    csi({ intermediates: '$', final: 'p' }, () => true),
    csi({ prefix: '?', intermediates: '$', final: 'p' }, () => true),
    p.registerDcsHandler({ intermediates: '$', final: 'q' }, () => parsingReplay()),
    osc(4, paletteQuery),
    osc(10, anyQuestion),
    osc(11, anyQuestion),
    osc(12, anyQuestion),
  ];
  return () => handlers.forEach((h) => h.dispose());
}
