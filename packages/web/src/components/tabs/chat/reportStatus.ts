// Pure helpers behind <StatusNotice>: recognise a report_status tool call and pull its fields
// out of the raw tool arguments. Split from the component so the parsing (the only interesting
// logic) is unit-tested without rendering.
//
// Why this exists: a thread ends a turn by calling report_status({ state, summary, ask?,
// blocker? }). In thread view every tool EXCEPT AskUserQuestion falls through to a collapsed
// "Wrench" block, so the summary/ask/blocker are hidden until you expand it — the model's actual
// findings and question get buried in a tool call while its visible reply is a terse "waiting on
// your feedback". Surfacing report_status inline (driven by this parser) is the render-layer fix,
// independent of what the thread's system prompt says, so it works on existing threads too.

export interface ReportStatusFields {
  state?: 'done' | 'needs_you' | 'blocked' | string;
  summary?: string;
  ask?: string;
  blocker?: string;
}

/** True for a report_status tool call under any MCP server name — the agent's own tool is
 *  namespaced `mcp__<server>__report_status` (server is usually "dispatch"), and a bare
 *  `report_status` can appear too. endsWith covers every namespacing without hard-coding a
 *  server name; no other tool ends in "report_status". */
export function isReportStatusTool(toolName?: string): boolean {
  return !!toolName && (toolName === 'report_status' || toolName.endsWith('__report_status'));
}

/** Parse the tool call's raw JSON arguments (transcript.ts writes them as pretty JSON) into the
 *  four fields, tolerating absent/malformed input exactly like the rest of the transcript
 *  parsing — a garbled blob is just "nothing to surface", never a throw. Empty/whitespace
 *  strings collapse to undefined so the component can treat "absent" and "blank" alike. */
export function parseReportStatus(toolInput?: string): ReportStatusFields | null {
  if (!toolInput) return null;
  let o: unknown;
  try { o = JSON.parse(toolInput); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const rec = o as Record<string, unknown>;
  const pick = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const fields: ReportStatusFields = {
    state: pick(rec.state),
    summary: pick(rec.summary),
    ask: pick(rec.ask),
    blocker: pick(rec.blocker),
  };
  // Nothing usable at all → null, so the caller falls back to the generic tool row rather than
  // rendering an empty notice.
  if (!fields.state && !fields.summary && !fields.ask && !fields.blocker) return null;
  return fields;
}
