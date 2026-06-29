import React from 'react';
import { renderMarkdown } from '../lib/markdown';

/**
 * Shared markdown surface for the agent chat and the coordinator stream. Routing both
 * through ONE component gives those two surfaces a single `dangerouslySetInnerHTML`
 * chokepoint, styled via `.md-view`.
 *
 * `minWidth:0` lets the host flex/grid track shrink so wide content (code blocks,
 * tables) scrolls inside `.md-view` instead of blowing out the column.
 */
// SANITIZER NOTE: DOMPurify intentionally deferred (Slice 1). When added it lands here and
// covers the agent + coordinator markdown — but NOT every raw-HTML site. These other markdown
// renders still call renderMarkdown + dangerouslySetInnerHTML directly and must be swept too:
//   ConversationView.tsx (L453, L459, L463, L464, L474) and toolviews/WebView.tsx (L16).
// (Code-highlight sinks — ToolCall / QueryView / DiffView via highlightCode — are a separate pass.)
export const Markdown = React.memo(function Markdown({ source }: { source: string }) {
  return <div className="md-view" style={{ minWidth: 0 }} dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }} />;
});
