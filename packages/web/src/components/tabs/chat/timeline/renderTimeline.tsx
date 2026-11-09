import type { ReactNode } from 'react';
import { MessageScroller } from '@shadcn/react/message-scroller';
import type { ConvItem, PermissionQuestion } from '../../../../api/types';
import { AnsweredQuestionCard } from '../AskQuestionCard';
import { DismissableStatusNotice } from '../StatusNotice';
import { noticeHidden, type NoticeFilter } from '../../../../stores/dismissedNotices';
import { isReportStatusTool, parseReportStatus, reportStatusKey } from '../reportStatus';
import { ModelNotice } from '../ModelSwitcher';
import { ChatImage } from '../../../ChatImage';
import { ToolCall, ToolResult } from '../../ToolCall';
import { uiKeyOf } from '../../../../hooks/useToolUIState';
import { stableId } from './stableId';
import { AssistantTurn, MachineryBlock, ToolGroup, UserBubble, AssistantText, Thinking, ResultFooter, TaskNotice } from './leaves';

/**
 * Surface-specific hooks into renderTimeline, so one renderer serves every transcript view.
 * Every hook is optional; leaving one out keeps the thread view's own rendering. Used by the
 * Control Plane (overseer/timeline.tsx's controlPlaneTimeline) for its agent cards, its
 * agency notices and its ledger chips, and by Chat (endless/timeline.tsx's chatTimeline)
 * for its cards, its doc chips and its per-message anchors.
 */
export interface TimelineExtensions {
  /** A tool call drawn as a custom card, given its paired result (if any yet). Return
   *  undefined to fall through to the default rendering, or null to draw nothing — the
   *  call's paired result is then hidden too. The card sits in the assistant turn's column,
   *  outside any machinery strip, and is never folded into a same-tool ToolGroup. */
  toolCard?(tool: ConvItem, result: ConvItem | undefined): ReactNode | undefined;
  /** True to drop a standalone tool result (one whose call is not in the window). */
  hideResult?(result: ConvItem): boolean;
  /** A user turn drawn as something other than the human's bubble (e.g. a daemon notice that
   *  arrived on the user role). Return undefined for the default UserBubble, null to drop the
   *  turn. A custom row is its own centered row: it is not part of the human's turn, so it
   *  draws no turn separator and does not group with the bubbles around it. */
  userRow?(item: ConvItem): ReactNode | undefined;
  /** Assistant prose, given the item it came from. Default: <AssistantText>. */
  prose?(text: string, item: ConvItem): ReactNode;
  /** Drawn in place of the login-error result (`loginItem`): Pretty's signed-out card. */
  authCard?: ReactNode;
  /** Plain (non-markdown) text inside user bubbles and report_status cards. Default: the text. */
  plainText?(text: string): ReactNode;
  /** Wraps each drawn unit, given the items it draws in order: one item, a tool call with its
   *  paired result, or a same-tool run with its results. For a surface that needs its own
   *  anchor, highlight or label around every message (Chat: per-message scroll ids, the search
   *  focus outline, the project label and file chips). It never changes the grouping, keys or
   *  pairing. Default: the node as is. */
  frame?(items: ConvItem[], node: ReactNode): ReactNode;
  /** Send again the message of a failed local bubble (W2-I). Absent: the bubble shows "Not sent" with no button. */
  retrySend?(localId: string): void;
}

/**
 * Walk the timeline, pairing each tool with its result by id (parallel-safe) and
 * grouping each assistant turn into ONE row: a flush-left column holding that
 * turn's text / thinking / tool cards / footer. A `user` turn breaks the group
 * and renders its own right-aligned bubble. `pageBoundaries` (see usePageBoundaries)
 * also forces a break — otherwise a loadOlder() prepend
 * could silently merge into a group that already existed, defeating scroll preservation.
 */
export function renderTimeline(items: ConvItem[], onViewFile: (p: string) => void, pageBoundaries: Set<ConvItem>, relayName?: string, loginItem?: ConvItem | null, notices?: NoticeFilter, ext?: TimelineExtensions) {
  // Map tool_use id -> its result item, so paired results aren't rendered standalone.
  const resultById = new Map<string, ConvItem>();
  // Set of tool ids that actually have a tool card, so an ORPHAN result (whose tool
  // was trimmed from the replay ring / arrived out of order) is still rendered
  // standalone instead of being silently dropped.
  const toolIds = new Set<string>();
  // Results already folded into a tool row by ADJACENCY pairing (the id-less shape). Filled
  // during the walk below — a result is always reached after the tool that claimed it.
  const consumed = new Set<ConvItem>();
  for (const it of items) {
    if (it.kind === 'tool-result' && it.toolId) resultById.set(it.toolId, it);
    if (it.kind === 'tool' && it.toolId) toolIds.add(it.toolId);
  }

  // A surface's frame around each drawn unit (ext.frame); identity when it has none.
  const frame = (covered: ConvItem[], node: React.ReactNode): React.ReactNode => (ext?.frame ? ext.frame(covered, node) : node);

  const rows: React.ReactNode[] = [];
  // Whether the previously RENDERED row was part of the human's turn (bubble or attached
  // image). Consecutive user rows group: one YOU label on the first, no separators between.
  // Strict adjacency (David's final rule): grouped when NOTHING rendered between them,
  // split when ANYTHING did — including a tool strip.
  let lastRowWasUser = false;
  let group: { key: string; nodes: React.ReactNode[] } | null = null;
  // Consecutive machinery nodes (tool calls/groups/orphan results) coalesce into ONE
  // hairline-bordered block per the redesign — a run of calls reads as a single strip of
  // terminal output between prose paragraphs, not a stack of standalone cards.
  let mach: { key: string; nodes: React.ReactNode[] } | null = null;
  const flushMach = () => {
    if (mach && mach.nodes.length > 0 && group) {
      group.nodes.push(<MachineryBlock key={`m-${mach.key}`} nodes={mach.nodes} />);
      group.key = mach.key;
    }
    mach = null;
  };
  const flushGroup = () => {
    flushMach();
    if (group && group.nodes.length > 0) {
      rows.push(
        <MessageScroller.Item key={group.key} messageId={group.key} style={{ display: 'flex' }}>
          <AssistantTurn>{group.nodes}</AssistantTurn>
        </MessageScroller.Item>,
      );
      lastRowWasUser = false;
    }
    group = null;
  };
  const pushMach = (id: string, node: React.ReactNode) => {
    if (!group) group = { key: id, nodes: [] };
    group.key = id;
    if (!mach) mach = { key: id, nodes: [] };
    mach.key = id;
    mach.nodes.push(<div key={id}>{node}</div>);
  };

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const id = stableId(it);

    // A blank assistant/thinking item (a streamed message whose text block is empty —
    // the common shape when a message only carries tool calls) renders nothing, but if
    // it reaches the push path it still SPLITS a machinery strip in two and occupies a
    // flex-gap slot — the "inconsistent tool-call spacing" bug: hollow hairline bands
    // between blocks that should have been one strip. Skip it before it breaks anything.
    if ((it.kind === 'assistant' || it.kind === 'thinking') && !(it.text ?? '').trim()) continue;

    if (pageBoundaries.has(it)) flushGroup();

    if (it.kind === 'user') {
      const custom = ext?.userRow?.(it);
      if (custom === null) continue;
      if (custom !== undefined) {
        flushGroup();
        rows.push(
          <MessageScroller.Item key={id} messageId={id} style={{ display: 'flex', flexDirection: 'column' }}>
            {frame([it], custom)}
          </MessageScroller.Item>,
        );
        lastRowWasUser = false;
        continue;
      }
      flushGroup();
      // Turn separator: a hairline between the previous assistant block and this user turn,
      // so long threads read as clearly delimited exchanges (redesign). Not before the
      // first row, and not between CONSECUTIVE user rows — back-to-back sends read as one
      // turn: one YOU label on the first, the rest grouped tight beneath it.
      if (rows.length > 0 && !lastRowWasUser) {
        rows.push(<div key={`sep-${id}`} aria-hidden style={{ height: 1, background: 'var(--color-hover)', flexShrink: 0 }} />);
      }
      rows.push(
        <MessageScroller.Item key={id} messageId={id} style={{ display: 'flex', flexDirection: 'column' }}>
          {frame([it], <UserBubble text={it.text ?? ''} source={it.source} grouped={lastRowWasUser} relayName={relayName} renderText={ext?.plainText} sendState={it.sendState} onRetry={it.sendState === 'failed' && it.localId && ext?.retrySend ? () => ext.retrySend!(it.localId!) : undefined} />)}
        </MessageScroller.Item>,
      );
      lastRowWasUser = true;
      continue;
    }

    // A user-attached image (imageFromUser) belongs with the human's turn: render it RIGHT-
    // aligned on its own row, like a UserBubble — not folded into the flush-left assistant
    // group the way a tool_result screenshot (imageFromUser falsy) is. Its caption, if any, is
    // a separate 'user' text item just above it.
    if (it.kind === 'image' && it.imageFromUser) {
      flushGroup();
      rows.push(
        <MessageScroller.Item key={id} messageId={id} style={{ display: 'flex', flexDirection: 'column' }}>
          {frame([it], (
            <div style={{ alignSelf: 'flex-end', maxWidth: '85%', paddingBottom: 4 }}>
              <ChatImage src={it.imageUrl ?? ''} alt={it.imageAlt} />
            </div>
          ))}
        </MessageScroller.Item>,
      );
      // Part of the human's turn: a following caption/text send groups under the same YOU.
      lastRowWasUser = true;
      continue;
    }

    // A surface's own card for this call (ext.toolCard) wins over everything below,
    // including the same-tool run grouping. Resolved with the same pairing rule as the
    // single-call path: by id, else by adjacency (marked consumed so it doesn't re-render).
    let custom: React.ReactNode | undefined;
    // The items the node below draws, for ext.frame: this one, plus a tool call's paired result.
    let covered: ConvItem[] = [it];
    if (it.kind === 'tool' && ext?.toolCard) {
      const result = it.toolId ? resultById.get(it.toolId) : items[i + 1]?.kind === 'tool-result' ? items[i + 1] : undefined;
      custom = ext.toolCard(it, result);
      if (custom !== undefined && result && !it.toolId) consumed.add(result);
      if (result) covered = [it, result];
    }

    // Look ahead for a run of consecutive same-tool calls (ignoring their interleaved
    // results, which are rendered paired). A run of 2+ collapses into one ToolGroup.
    // AskUserQuestion is excluded — it has live-overlay special-casing below.
    if (custom === undefined && it.kind === 'tool' && it.toolName !== 'AskUserQuestion' && !isReportStatusTool(it.toolName)) {
      const run: ConvItem[] = [it];
      // Tool-result items encountered while scanning the run, IN ENCOUNTER ORDER — used
      // below for en-bloc pairing of toolId-less members (see the `pairs` comment). Not
      // re-derived via items.indexOf() below, so advancing `i` past the run afterward is
      // an O(1) lookup — items.indexOf(run[run.length - 1]) would be an O(n) scan per
      // group (O(n^2) per render), and if `items` ever held a duplicated object reference
      // it could return an EARLIER index, moving `i` backwards into an infinite render loop.
      const runResults: ConvItem[] = [];
      let lastIdx = i;
      for (let j = i + 1; j < items.length; j++) {
        const nxt = items[j];
        if (pageBoundaries.has(nxt)) break;                    // boundary wins over everything
        if (nxt.kind === 'tool-result') {
          // A paired result is transparent to the run. An ORPHAN result (its tool_use fell
          // outside the replay window) renders standalone, so it must not be swallowed by
          // the run's index jump below — end the run before it instead. A toolId-less
          // result (older REST-paged history has no ids at all) has nothing to check
          // against, so it stays transparent here and is paired en bloc (below) when the
          // run's pairs are resolved.
          if (nxt.toolId && !toolIds.has(nxt.toolId)) break;
          runResults.push(nxt);
          lastIdx = j;
          continue;
        }
        if (nxt.kind !== 'tool' || nxt.toolName !== it.toolName) break;
        run.push(nxt);
        lastIdx = j;
      }
      if (run.length > 1) {
        // Resolve each run member's result ONCE: by toolId via `resultById` when it has
        // one (position-independent — correct for both the sequential [T,R,T,R] shape AND
        // the batched [T,T,R,R] shape Claude Code actually emits for parallel same-tool
        // calls: every tool_use block lands in ONE assistant message, all tool_results in
        // the NEXT user message). A toolId-less member (older REST-paged history has no
        // ids at all) has nothing to match by id, so it's paired EN BLOC instead: the k-th
        // toolId-less run member gets the k-th toolId-less result encountered during the
        // scan above — plain items[idx+1] adjacency would wrongly leave every result
        // orphaned except the run's last (all the results trail after both tool_uses in
        // the batched shape), permanently stuck on "running…" with a dead collapse button.
        let toolIdLessSeen = 0;
        const pairs = run.map((t) => ({
          tool: t,
          result: t.toolId ? resultById.get(t.toolId) : runResults[toolIdLessSeen++],
        }));
        const lastId = stableId(run[run.length - 1]);
        const runItems = pairs.flatMap((p) => (p.result ? [p.tool, p.result] : [p.tool]));
        pushMach(lastId, frame(runItems, <ToolGroup pairs={pairs} onViewFile={onViewFile} />));
        // Skip past the run's members; their paired results are skipped by the
        // existing `toolIds.has(...)` guard on the 'tool-result' branch.
        i = lastIdx;
        continue;
      }
    }

    let node: React.ReactNode = null;
    if (custom !== undefined) node = custom;
    else if (it.kind === 'assistant') node = ext?.prose ? ext.prose(it.text ?? '', it) : <AssistantText text={it.text ?? ''} />;
    else if (it.kind === 'image') node = <ChatImage src={it.imageUrl ?? ''} alt={it.imageAlt} />;
    else if (it.kind === 'thinking') node = <Thinking id={uiKeyOf(it)} text={it.text ?? ''} />;
    else if (it.kind === 'tool') {
      const result = it.toolId ? resultById.get(it.toolId) : items[i + 1]?.kind === 'tool-result' ? items[i + 1] : undefined;
      // A result paired by ADJACENCY (neither side has a toolId — the shape REST-paged
      // history always has, since conversation/transcript.ts emits no ids at all) must be
      // marked consumed here. The `toolIds.has(...)` guard on the 'tool-result' branch below
      // can only recognize an id-based pairing, so without this the very same output rendered
      // twice on every REST-paged tool call: once folded into the tool row's "N lines", then
      // again as a stray "Output · N lines" row directly beneath it.
      if (result && !it.toolId) consumed.add(result);
      if (result) covered = [it, result];
      if (it.toolName === 'AskUserQuestion') {
        // While still pending (no tool_result yet) the interactive <AskQuestionCard> below
        // (the live overlay) covers it — node stays null and this item renders nothing here,
        // same as before. Once answered, its tool_result is a REAL, durable part of the
        // transcript (same as any other tool call) — render the collapsed record instead of
        // dropping it forever (the previous behavior: this whole branch used to `continue`
        // unconditionally, which is why an answered question vanished with no trace).
        if (result) {
          let questions: PermissionQuestion[] = [];
          try { questions = JSON.parse(it.toolInput ?? '{}')?.questions ?? []; } catch { /* malformed */ }
          if (questions.length) node = <AnsweredQuestionCard questions={questions} resultText={result.text ?? ''} />;
        }
      } else if (isReportStatusTool(it.toolName) && parseReportStatus(it.toolInput)) {
        // Surface the buried status inline instead of the collapsed tool row: the model's
        // findings/question (report_status summary/ask/blocker) become visible in thread view.
        // The `{ ok: true }` result is already consumed by the pairing logic above, so it won't
        // render a stray row beneath. Falls back to the generic ToolCall when there's no usable
        // content to show.
        // A card the reader closed (×) is skipped outright — not rendered empty — so it leaves
        // no gap in the turn. The wrapper's own null-return is only the safety net for callers
        // that pass no filter.
        if (noticeHidden(notices, reportStatusKey(it.toolInput))) continue;
        node = <DismissableStatusNotice scope={notices?.scope} input={it.toolInput} renderText={ext?.plainText} />;
      } else {
        // Generic machinery — routes through pushMach so consecutive calls share one
        // bordered block, and so the header's Hide-tool-calls toggle can drop it.
        pushMach(id, frame(covered, <ToolCall tool={it} result={result} onViewFile={onViewFile} />));
        continue;
      }
    } else if (it.kind === 'tool-result') {
      if (it.toolId && toolIds.has(it.toolId)) continue; // already shown paired with its tool
      if (consumed.has(it)) continue;                    // ...or paired by adjacency, above
      if (ext?.hideResult?.(it)) continue;               // ...or a surface hides it outright
      pushMach(id, frame([it], <div style={{ padding: '0 20px' }}><ToolResult item={it} /></div>));
      continue;
    } else if (it.kind === 'result') node = it === loginItem && ext?.authCard ? ext.authCard : <ResultFooter item={it} login={it === loginItem} />;
    // A system-injected event (background-task completion) that arrived as a `user`-role
    // turn. Deliberately does NOT flushGroup() the way a real `user` turn does: it isn't a
    // new speaker, it's an interruption inside the assistant's own turn — the assistant
    // usually acts on it in the very next block, so breaking the column there would split
    // one continuous turn into two.
    else if (it.kind === 'notice') node = <TaskNotice text={it.text ?? ''} />;
    else if (it.kind === 'system' && it.systemKind === 'model' && it.text) node = <ModelNotice model={it.text} />;
    if (node == null) continue;

    // A non-machinery node closes any open machinery strip first, so the bordered block
    // ends exactly where the prose resumes.
    flushMach();
    if (!group) group = { key: id, nodes: [] };
    // Anchor the group's React key to its LAST item, re-set on every push (not just at
    // creation). A group's start can move earlier when loadOlder() prepends older history
    // that merges into it (no `user` boundary between them) — keying by the first item would
    // then change the key every time, forcing React to unmount+remount the node and breaking
    // MessageScroller's preserveScrollOnPrepend (it tracks anchor position by DOM node
    // identity). The group's LAST item is untouched by anything prepended before it, so
    // keying there keeps the node — and the reader's scroll position — stable across a page.
    group.key = id;
    group.nodes.push(<div key={id}>{frame(covered, node)}</div>);
  }
  flushGroup();
  return rows;
}
