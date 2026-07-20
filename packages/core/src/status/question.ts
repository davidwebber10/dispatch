/**
 * Does this turn end by asking the human for something?
 *
 * The backstop for when an agent doesn't call `report_status`. Claude Code's turn-end
 * `result` event carries no indication of intent, so without this a turn ending
 * "…does that look right?" is indistinguishable from one that finished the job.
 *
 * Deliberately checks only the CLOSING sentence, not the whole message: models pose
 * rhetorical questions mid-explanation constantly ("Why does this fail? Because…"),
 * and treating those as asks would flood the needs-help state with false positives.
 * What matters is how the turn was left.
 *
 * Never used when the agent declared its state — declaration always wins.
 */

// Fenced code blocks routinely contain question marks in strings and comments; strip
// them before looking at the prose so `throw new Error("who?")` isn't read as an ask.
// The `(?:```|$)` alternative also tolerates an unterminated block — a message
// truncated mid-code-fence still gets its fence content stripped instead of leaking
// into the closing-thought check.
const FENCE = /```[\s\S]*?(?:```|$)/g;

// Phrasings that hand the decision back without necessarily using a question mark.
// Kept deliberately narrow: under-detection is the safe direction here (see module
// doc), so every entry should be unambiguously addressed to the human, not just a
// word that happens to co-occur with asks. Bare "confirm", for example, matches
// ordinary completion reports ("Logs confirm the deploy succeeded.") — a genuine
// confirm-ask almost always ends in "?" anyway, which the question-mark rule already
// covers, so narrowing it costs almost no real detection.
const ASK_PHRASES = [
  /\blet me know\b/i,
  /\bwhich (one )?(would you|do you)\b/i,
  /\bdo you want\b/i,
  /\bwould you (like|prefer)\b/i,
  /\bshould i\b/i,
  /\bshall i\b/i,
  /\b(please confirm|can you confirm|could you confirm|confirm that you)\b/i,
  /\byour call\b/i,
  /\bup to you\b/i,
  /\bi need (the|your|a)\b/i,
  /\bwaiting (on|for) you\b/i,
];

// A line that opens its own thought rather than continuing the previous one: a bullet,
// a numbered item, or a heading.
const LIST_MARKER = /^(?:[-*•]|\d+[.)]|#{1,6}\s)/;

/**
 * Rejoin lines that are soft-wrapped continuations of the line above.
 *
 * Splitting naively on every `\n` is wrong in both directions. Agent output is often a
 * bullet list with no terminal punctuation, where the whole message would otherwise
 * collapse into one "sentence" and let an early bullet's phrasing leak into the check.
 * But prose also wraps mid-sentence, and treating that break as a boundary truncates the
 * closing thought — "…let me know if you want changes\nbefore I merge" would be read as
 * just "before I merge" and the ask would be missed.
 *
 * A line continues the previous one when the previous didn't end on terminal punctuation
 * AND this one isn't a list marker or heading.
 */
function closingThoughtLines(prose: string): string[] {
  const raw = prose.split('\n').map((l) => l.trim()).filter(Boolean);
  const out: string[] = [];
  for (const line of raw) {
    const prev = out[out.length - 1];
    const opensNewThought = !prev || /[.!?:]$/.test(prev) || LIST_MARKER.test(line);
    if (opensNewThought) out.push(line);
    else out[out.length - 1] = `${prev} ${line}`;
  }
  return out;
}

export function looksLikeQuestion(text: string): boolean {
  const prose = (text ?? '').replace(FENCE, ' ').trim();
  if (!prose) return false;

  // Isolate the closing thought: unwrap soft line breaks, take the last logical line,
  // then the last sentence within it.
  const lines = closingThoughtLines(prose);
  const lastLine = lines[lines.length - 1] ?? '';

  const sentences = lastLine.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const last = sentences[sentences.length - 1] ?? '';

  if (last.endsWith('?')) return true;
  return ASK_PHRASES.some((re) => re.test(last));
}
