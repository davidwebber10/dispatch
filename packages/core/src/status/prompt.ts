/**
 * Parses a *rendered* terminal screen (see `renderScreen`) into a normalized,
 * provider-agnostic interactive prompt. Pure — no I/O — so each prompt shape is
 * locked down by a fixture test.
 *
 * Covers the dominant shapes across Claude (`❯` cursor) and Codex (`›` cursor):
 * numbered selects and (y/n) confirms. A cursor-list with a recognizable footer
 * but no parseable options falls back to `parsed:false` (the web shows an inline
 * terminal). Idle screens match nothing → null (no false prompts).
 */

export interface PromptOption { label: string; keys: string }
export interface DetectedPrompt {
  kind: string;            // 'select' | 'confirm' | 'unknown'
  question: string;
  options: PromptOption[];
  parsed: boolean;         // false → inline-terminal fallback
  raw?: string;
}

const CURSOR = /[❯›]/;                                       // Claude ❯ / Codex ›
// A cursor that actually HIGHLIGHTS an option (followed by content on the SAME
// line) — NOT claude's bare idle input box (just "❯" with nothing after it).
// Uses literal spaces/tabs, not \s, so it can't span a newline into the next line.
const MENU_CURSOR = /[❯›][ \t]+\S/;
const OPTION_RE = /^\s*([❯›>])?\s*(\d+)[.)]\s+(.+?)\s*$/;    // "❯ 1. Label" / "  2. Label"
const DIVIDER_RE = /^[\s─━—_=·•]+$/;
// The submit footer of a real interactive menu (trust / select / codex). Kept
// narrow so it doesn't match prose: only the actual confirm/continue prompts.
const SELECT_FOOTER = /(enter to (confirm|continue|select)|press enter to)/i;

/** Arrow keystrokes to move the highlight from `from` to `to`, then Enter. */
function navKeys(from: number, to: number): string {
  const d = to - from;
  if (d === 0) return '\r';
  return (d > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(d)) + '\r';
}

function buildQuestion(linesAbove: string[]): string {
  const text = linesAbove
    .filter((l) => l.trim() && !DIVIDER_RE.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 280 ? text.slice(0, 279) + '…' : text;
}

function firstMeaningful(screen: string): string {
  return screen.split('\n').map((l) => l.trim()).find((l) => l && !DIVIDER_RE.test(l)) || '';
}

function parseConfirm(screen: string): DetectedPrompt | null {
  const line = screen.split('\n').reverse().find((l) => /\(y\/n\)/i.test(l));
  if (!line) return null;
  const question = line.replace(/\(y\/n\)\s*$/i, '').trim() || 'Confirm?';
  return {
    kind: 'confirm',
    question,
    options: [{ label: 'Yes', keys: 'y' }, { label: 'No', keys: 'n' }],
    parsed: true,
  };
}

function parseNumberedSelect(screen: string): DetectedPrompt | null {
  const lines = screen.split('\n');
  const opts: { idx: number; label: string; cursor: boolean }[] = [];
  let firstLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(OPTION_RE);
    if (m) {
      const num = parseInt(m[2], 10);
      if (opts.length === 0 && num !== 1) continue;          // wait for the list to start at 1
      if (opts.length > 0 && num !== opts.length + 1) break; // non-contiguous → list ended
      if (firstLine < 0) firstLine = i;
      opts.push({ idx: num - 1, label: m[3].trim(), cursor: CURSOR.test(m[1] || '') });
    } else if (opts.length > 0 && lines[i].trim()) {
      break;                                                 // a non-empty non-option line ends the block
    }
  }
  if (opts.length < 2) return null;
  const found = opts.findIndex((o) => o.cursor);
  // Real interactive menu, not a numbered list in normal output: it must have the
  // selection cursor ON an option AND a submit footer. Otherwise it's just prose.
  if (found < 0 || !SELECT_FOOTER.test(screen)) return null;
  const cursorIdx = found;
  return {
    kind: 'select',
    question: buildQuestion(lines.slice(0, firstLine)) || 'Choose an option',
    options: opts.map((o) => ({ label: o.label, keys: navKeys(cursorIdx, o.idx) })),
    parsed: true,
  };
}

function parseFallback(screen: string): DetectedPrompt | null {
  // A cursor list we couldn't enumerate (e.g. resume picker). Require a cursor
  // that highlights an option (not the bare input box) AND a real submit footer,
  // so we never fire on the idle input box or normal output.
  if (!MENU_CURSOR.test(screen) || !SELECT_FOOTER.test(screen)) return null;
  return { kind: 'unknown', question: firstMeaningful(screen) || 'The agent is asking for input', options: [], parsed: false, raw: screen };
}

/** `screen` must already be rendered (renderScreen). `provider` reserved for future provider-specific shapes. */
export function detectPrompt(_provider: string, screen: string): DetectedPrompt | null {
  if (!screen || !screen.trim()) return null;
  return parseConfirm(screen) || parseNumberedSelect(screen) || parseFallback(screen) || null;
}
