import { useMemo } from 'react';
import { highlightCode } from '../lib/markdown';
import { useHighlightLanguage } from '../lib/highlight';

/**
 * The <code> of a highlighted code view outside <Markdown> (a tool call's input or output, a
 * written file, a query). `lang` unset: auto-detect. A language that is not in the first load
 * (lib/highlight.ts, W2-E) shows as plain text first; this component renders again when it is in.
 */
export function HighlightedCode({ code, lang }: { code: string; lang?: string }) {
  const ready = useHighlightLanguage(lang);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `ready` changes when the language arrived
  const html = useMemo(() => highlightCode(code, lang), [code, lang, ready]);
  return <code dangerouslySetInnerHTML={{ __html: html }} />;
}
