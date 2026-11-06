// Chat's log (EndlessMessage[]) as the ConvItem[] the thread view's renderTimeline draws.
// Pure: no React, no store. endless/timeline.tsx holds Chat's renderTimeline hooks.
//
// Ids. Every item's uuid is `e<i>` (the message's index in the log), or `e<i>:<k>` for the k-th
// image of a user message. Every tool call gets its own toolId `chat:t<i>`, and the result it
// pairs with (pairEchoes) carries the same id, so renderTimeline pairs by id only and never by
// adjacency. A result with no call in the window gets `chat:r<i>`, an id no call has, so it
// draws as a standalone result. The scroll ids search jumps use (`m<key>`, see rowKeyOf) are
// added by chatTimeline's frame, not here.

import type { ConvItem, EndlessMessage } from '../../api/types';
import { endlessMediaUrl } from '../../api/client';
import { SPAWN_TOOL } from './spawn';

export const ZOOM_TOOL = /^mcp__memory__zoom\s/;
/** A thread report (kind 'work') and an imported-memories note (kind 'note') ride as tool calls
 *  with these names: chatTimeline's toolCard draws them as Chat's own cards. */
export const REPORT_TOOL = 'chat:report';
export const NOTE_TOOL = 'chat:note';

/** A saved media name is `<time>-<k>-<8 hex>-<the user's name>`; an image has no user name part. */
export const isImageMedia = (name: string) => /\.(png|jpe?g|gif|webp)$/i.test(name);

/**
 * Each tool call's result, by the call's `i`. A call that carries an id (`ref`) pairs with the
 * first later result with the same id, wherever it sits in the list. Calls and results logged
 * before ids existed have no `ref`: a run of N such calls pairs with the run of up to N results
 * right after it, in order. A ref-carrying call never pairs by position.
 */
export function pairEchoes(messages: EndlessMessage[]): Map<number, EndlessMessage> {
  const echoOf = new Map<number, EndlessMessage>();
  const open = new Map<string, EndlessMessage[]>(); // ref -> calls still waiting, oldest first
  for (const m of messages) {
    if (m.kind === 'tool' && m.ref) open.set(m.ref, [...(open.get(m.ref) ?? []), m]);
    else if (m.kind === 'echo' && m.ref) {
      const tool = open.get(m.ref)?.shift();
      if (tool) echoOf.set(tool.i, m);
    }
  }
  let k = 0;
  while (k < messages.length) {
    const m = messages[k];
    if (m.kind !== 'tool' || m.ref) { k++; continue; }
    const tools: EndlessMessage[] = [];
    while (k < messages.length && messages[k].kind === 'tool' && !messages[k].ref && (tools.length === 0 || messages[k].i === tools[tools.length - 1].i + 1)) tools.push(messages[k++]);
    const echoes: EndlessMessage[] = [];
    while (k < messages.length && echoes.length < tools.length && messages[k].kind === 'echo' && !messages[k].ref && messages[k].i === (echoes.length ? echoes[echoes.length - 1].i : tools[tools.length - 1].i) + 1) echoes.push(messages[k++]);
    echoes.forEach((echo, n) => echoOf.set(tools[n].i, echo));
  }
  return echoOf;
}

/** A tool message's text is `<name> <input>`. */
export function splitTool(text: string): { name: string; input: string } {
  const name = text.split(' ')[0];
  return { name, input: text.slice(name.length + 1) };
}

function build(m: EndlessMessage, callOf: Map<number, number>): ConvItem[] {
  const uuid = `e${m.i}`;
  switch (m.kind) {
    case 'user':
      return [
        { kind: 'user', text: m.text, uuid },
        ...m.media.filter(isImageMedia).map((name, k): ConvItem => ({ kind: 'image', imageUrl: endlessMediaUrl(name), imageFromUser: true, uuid: `${uuid}:${k}` })),
      ];
    case 'unii': return [{ kind: 'assistant', text: m.text, uuid }];
    case 'work': return [{ kind: 'tool', toolName: REPORT_TOOL, toolId: `chat:t${m.i}`, text: m.text, uuid }];
    case 'note': return [{ kind: 'tool', toolName: NOTE_TOOL, toolId: `chat:t${m.i}`, text: m.text, uuid }];
    case 'tool': {
      const { name, input } = splitTool(m.text);
      return [{ kind: 'tool', toolName: name, toolInput: input, toolId: `chat:t${m.i}`, uuid }];
    }
    case 'echo': {
      const call = callOf.get(m.i);
      return [{ kind: 'tool-result', text: m.text, toolId: call === undefined ? `chat:r${m.i}` : `chat:t${call}`, uuid }];
    }
  }
}

// The items last built for a message. renderTimeline (usePageBoundaries, the group keys) tracks
// items by identity across renders, so an unchanged message must give back the same objects.
const built = new WeakMap<EndlessMessage, { call: number | undefined; items: ConvItem[] }>();

/** Chat's messages as ConvItems, in order (see the file comment for the ids). */
export function toConvItems(messages: EndlessMessage[]): ConvItem[] {
  const callOf = new Map<number, number>(); // echo.i -> its call's i
  for (const [tool, echo] of pairEchoes(messages)) callOf.set(echo.i, tool);
  const answered = new Set(callOf.values());
  // The last reply or user message: a call before it is over, whether or not its result was logged.
  let lastTurn = -1;
  for (let k = messages.length - 1; k >= 0; k--) if (messages[k].kind === 'user' || messages[k].kind === 'unii') { lastTurn = k; break; }
  return messages.flatMap((m, k) => {
    const call = callOf.get(m.i);
    const hit = built.get(m);
    let items: ConvItem[];
    if (hit && hit.call === call) items = hit.items;
    else { items = build(m, callOf); built.set(m, { call, items }); }
    // A plain tool call whose result was never logged (an interrupted turn) and that the
    // conversation has since moved past: draw it finished with no output, not "running…" forever
    // (2026-11-05). Chat's own cards (Started, recalled, reports, notes) take a missing result as is.
    if (m.kind === 'tool' && k < lastTurn && !answered.has(m.i) && !ZOOM_TOOL.test(m.text) && !SPAWN_TOOL.test(m.text)) {
      return [...items, noResult(m)];
    }
    return items;
  });
}

const noResults = new WeakMap<EndlessMessage, ConvItem>();
/** The stand-in result of a call that never logged one (kept per message, so its identity is stable). */
function noResult(m: EndlessMessage): ConvItem {
  let r = noResults.get(m);
  if (!r) { r = { kind: 'tool-result', text: '(no output recorded)', toolId: `chat:t${m.i}`, uuid: `e${m.i}:none` }; noResults.set(m, r); }
  return r;
}

/** The Chat message (and, for a user message's image, which one) an item was built from. */
export function chatIndexOf(item: ConvItem): { i: number; piece: number | null } | null {
  const hit = /^e(-?\d+)(?::(\d+))?$/.exec(item.uuid ?? '');
  return hit ? { i: Number(hit[1]), piece: hit[2] === undefined ? null : Number(hit[2]) } : null;
}

/** The row key (scroll id `m<key>`) that shows message `i`: a paired result maps to its call. Null if not loaded. */
export function rowKeyOf(messages: EndlessMessage[], i: number): number | null {
  if (!messages.some((m) => m.i === i)) return null;
  for (const [tool, echo] of pairEchoes(messages)) if (echo.i === i) return tool;
  return i;
}
