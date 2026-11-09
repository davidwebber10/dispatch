import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import { hljs, allLanguagesReady, isLanguagePending, loadAllLanguages, loadLanguage } from './highlight';
// The highlight.js instance and its languages live in lib/highlight.ts: a curated set, of which the
// less common ones load on demand (W2-E).

/** Set for the time of one renderMarkdown call: gets each lazy language that a code block needs. */
let onMissing: ((lang: string) => void) | undefined;

const marked = new Marked(
  { gfm: true, breaks: false },
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
      if (language === 'plaintext' && isLanguagePending(lang)) onMissing?.(lang);
      try { return hljs.highlight(code, { language }).value; } catch { return code; }
    },
  }),
);

/**
 * Markdown to HTML (not sanitized: <Markdown> does that). A code block in a language that is not
 * loaded yet renders as plain text, and `missing` gets its name: the caller loads it
 * (lib/highlight.ts `loadLanguage`) and renders again.
 */
export function renderMarkdown(src: string, missing?: (lang: string) => void): string {
  onMissing = missing;
  try { return marked.parse(src ?? '') as string; }
  finally { onMissing = undefined; }
}

/** Auto-detect tries the languages in the order the app registered them before the split: a tie then goes to the same language. */
const AUTO_DETECT_ORDER = ['javascript', 'typescript', 'json', 'python', 'bash', 'css', 'xml', 'yaml', 'markdown', 'sql', 'go', 'rust', 'diff', 'ini', 'dockerfile', 'plaintext'];

const escapeHtml = (code: string): string => code.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

/** Highlight a raw code string. Uses `lang` (or its alias) when known; otherwise
 *  auto-detects. Returns inner HTML for a `<code class="hljs">`.
 *  A language (or, for auto-detect, the full set) that is not loaded yet gives escaped plain text
 *  and starts the load; a caller that uses `useHighlightLanguage` renders again when it is in. */
export function highlightCode(code: string, lang?: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    if (isLanguagePending(lang)) { void loadLanguage(lang!); return escapeHtml(code); }
    if (!allLanguagesReady()) { void loadAllLanguages(); return escapeHtml(code); }
    return hljs.highlightAuto(code, AUTO_DETECT_ORDER).value;
  } catch {
    return escapeHtml(code);
  }
}

/** Infer a highlight.js language from a file path's extension. */
export function langFromPath(path?: string): string | undefined {
  const ext = path?.split('.').pop()?.toLowerCase();
  if (!ext) return undefined;
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', html: 'xml', htm: 'xml',
    xml: 'xml', svg: 'xml', vue: 'xml', css: 'css', scss: 'css', yaml: 'yaml', yml: 'yaml', md: 'markdown',
    go: 'go', rs: 'rust', toml: 'ini', ini: 'ini', conf: 'ini', dockerfile: 'dockerfile', diff: 'diff', patch: 'diff',
  };
  return map[ext];
}
