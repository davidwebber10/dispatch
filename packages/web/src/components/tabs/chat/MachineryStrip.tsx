import type { ReactNode } from 'react';
import type { ConvItem } from '../../../api/types';
import { ToolCall, ToolResult } from '../ToolCall';
import { MachineryBlock, ToolGroup, type ToolPair } from './ChatView';

/**
 * A pure run of consecutive tool / tool-result ConvItems rendered as ONE machinery
 * strip — the Control Plane stream's counterpart of renderTimeline's pushMach path
 * (ChatView.tsx). renderTimeline can't be reused directly because its run-grouping is
 * woven through a loop that also interleaves prose, images and footers; this component
 * applies the SAME pairing and grouping rules to a slice that live.convItemsToStream
 * guarantees is machinery-only:
 *
 * - a result pairs with its tool by toolId (position-independent — covers the batched
 *   [T,T,R,R] shape parallel same-tool calls actually emit), or by adjacency when
 *   neither side has an id (REST-paged history);
 * - a run of 2+ consecutive same-tool calls collapses into one ToolGroup (results are
 *   transparent to the run; toolId-less members pair en bloc, k-th tool ↔ k-th result);
 * - an orphan result (its tool_use fell outside the window) renders standalone
 *   instead of dropping.
 */
export function MachineryStrip({ items, onViewFile }: { items: ConvItem[]; onViewFile?: (path: string) => void }) {
  const resultById = new Map<string, ConvItem>();
  const toolIds = new Set<string>();
  for (const it of items) {
    if (it.kind === 'tool-result' && it.toolId) resultById.set(it.toolId, it);
    if (it.kind === 'tool' && it.toolId) toolIds.add(it.toolId);
  }
  const consumed = new Set<ConvItem>();
  const view = onViewFile ?? (() => {});
  const nodes: ReactNode[] = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const key = it.toolId ?? it.uuid ?? `i${i}`;

    if (it.kind === 'tool') {
      // Look ahead for a run of consecutive same-tool calls (results are transparent
      // unless orphaned — an orphan must render standalone, so it ends the run).
      const run: ConvItem[] = [it];
      const runResults: ConvItem[] = [];
      let lastIdx = i;
      for (let j = i + 1; j < items.length; j++) {
        const nxt = items[j];
        if (nxt.kind === 'tool-result') {
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
        let toolIdLessSeen = 0;
        const pairs: ToolPair[] = run.map((t) => ({
          tool: t,
          result: t.toolId ? resultById.get(t.toolId) : runResults[toolIdLessSeen++],
        }));
        for (const p of pairs) { if (p.result) consumed.add(p.result); }
        nodes.push(<ToolGroup key={`g${key}`} pairs={pairs} onViewFile={view} />);
        i = lastIdx;
        continue;
      }
      const result = it.toolId ? resultById.get(it.toolId) : items[i + 1]?.kind === 'tool-result' ? items[i + 1] : undefined;
      if (result) consumed.add(result);
      nodes.push(<ToolCall key={key} tool={it} result={result} onViewFile={view} />);
      continue;
    }

    if (it.kind === 'tool-result') {
      if (it.toolId && toolIds.has(it.toolId)) continue; // shown paired with its tool
      if (consumed.has(it)) continue;
      nodes.push(<div key={key} style={{ padding: '0 20px' }}><ToolResult item={it} /></div>);
    }
  }

  if (!nodes.length) return null;
  return <MachineryBlock nodes={nodes} />;
}
