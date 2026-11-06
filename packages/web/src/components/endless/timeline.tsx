// Chat — its hooks into the thread view's renderTimeline (components/tabs/chat/ChatView.tsx).
// Chat's log is turned into the ConvItem[] a thread renders by convItems.ts; these are the only
// places Chat draws it differently:
//
//   toolCard — a `mcp__memory__zoom` call is a "recalled" line (RecallLine); a spawn_agent call is
//              the Started card (StartedItem), which opens its thread in place; a thread report
//              and an imported-memories note (carried as REPORT_TOOL / NOTE_TOOL calls) are
//              Chat's WorkCard / NoteCard.
//   prose    — a Dispatch reply draws doc paths and doc links as doc chips for its message's
//              project (ChatProse).
//   frame    — every message gets its scroll id `m<key>` (search jumps, MemorySearch, the report
//              card's own scroll), the search focus outline, and, on a user message, the project
//              label above the bubble and the file chips under it.

import { useMemo, useRef, type ReactNode } from 'react';
import { MessageScroller } from '@shadcn/react/message-scroller';
import { renderTimeline, usePageBoundaries, type TimelineExtensions } from '../tabs/chat/ChatView';
import { endlessMediaUrl } from '../../api/client';
import type { ConvItem, EndlessMessage } from '../../api/types';
import { toConvItems, chatIndexOf, pairEchoes, isImageMedia, ZOOM_TOOL, REPORT_TOOL, NOTE_TOOL } from './convItems';
import { SPAWN_TOOL } from './spawn';
import { StartedItem } from './StartedItem';
import { CardOpenContext, ChatProse, FileChip, NoteCard, ProjectLabel, RecallLine, WorkCard, mediaDisplayName } from './EndlessMessageRow';

/** One drawn unit: an anchor per message it shows, the focus outline, and a user message's label and files. */
function ChatFrame({ keys, focused, user, children }: { keys: number[]; focused: boolean; user: EndlessMessage | null; children: ReactNode }) {
  const files = user ? user.media.filter((name) => !isImageMedia(name)) : [];
  const body = (
    <div data-endless-i={keys[0]} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, borderRadius: 'var(--radius-md)', outline: focused ? '1px solid var(--color-accent)' : 'none', outlineOffset: 4 }}>
      {user?.projectName && <ProjectLabel name={user.projectName} />}
      {children}
      {files.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {files.map((name) => <FileChip key={name} name={mediaDisplayName(name)} href={endlessMediaUrl(name)} />)}
        </div>
      )}
    </div>
  );
  // A unit that shows several messages (a same-tool run) is reachable by each one's id.
  return keys.reduceRight<ReactNode>((inner, key) => (
    <MessageScroller.Item messageId={`m${key}`} style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>{inner}</MessageScroller.Item>
  ), body);
}

/** Chat's renderTimeline extensions for this window of messages and search focus. */
export function chatTimeline(messages: EndlessMessage[], focus: number | null): TimelineExtensions {
  const byI = new Map(messages.map((m) => [m.i, m]));
  const callOf = new Map<number, number>(); // echo.i -> its call's i
  for (const [tool, echo] of pairEchoes(messages)) callOf.set(echo.i, tool);
  const msgOf = (item: ConvItem | undefined) => {
    const at = item ? chatIndexOf(item) : null;
    return at ? byI.get(at.i) : undefined;
  };
  return {
    toolCard: (tool, result) => {
      const m = msgOf(tool);
      if (!m) return undefined;
      if (tool.toolName === REPORT_TOOL) return <WorkCard m={m} />;
      if (tool.toolName === NOTE_TOOL) return <NoteCard m={m} />;
      if (ZOOM_TOOL.test(m.text)) return <RecallLine tool={m} />;
      if (SPAWN_TOOL.test(m.text)) return <StartedItem tool={m} echo={msgOf(result)} />;
      return undefined;
    },
    prose: (_text, item) => {
      const m = msgOf(item);
      return m ? <ChatProse m={m} /> : undefined;
    },
    frame: (items, node) => {
      const at = items.map(chatIndexOf).filter((x): x is { i: number; piece: number | null } => x !== null);
      // An image of a user message is not a row of its own: its message's id sits on the bubble.
      const keys = [...new Set(at.filter((x) => x.piece === null).map((x) => callOf.get(x.i) ?? x.i))];
      const focused = focus !== null && at.some((x) => x.i === focus);
      const first = items[0];
      const user = first.kind === 'user' ? msgOf(first) ?? null : null;
      return <ChatFrame keys={keys} focused={focused} user={user}>{node}</ChatFrame>;
    },
  };
}

const noFile = () => {};

/** Chat's message list: its log drawn through the thread view's renderTimeline. */
export function ChatTimeline({ messages, focus }: { messages: EndlessMessage[]; focus: number | null }) {
  const items = useMemo(() => toConvItems(messages), [messages]);
  // loadOlder() page starts, as group boundaries (see usePageBoundaries).
  const pageBoundaries = usePageBoundaries(items);
  const ext = useMemo(() => chatTimeline(messages, focus), [messages, focus]);
  const cardOpen = useRef(new Map<string, boolean>()).current;
  // The provider draws no element: the rows stay direct children of MessageScroller.Content.
  return <CardOpenContext.Provider value={cardOpen}>{renderTimeline(items, noFile, pageBoundaries, undefined, null, undefined, ext)}</CardOpenContext.Provider>;
}
