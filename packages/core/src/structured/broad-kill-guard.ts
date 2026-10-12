/**
 * Refuses Bash commands that signal processes by NAME or PATTERN instead of by PID: pkill,
 * killall, and kill fed by pgrep/pidof/ps. Every Claude agent Dispatch runs carries its prompt
 * in its command line, so a pattern meant for one loop can match all of them — on 2026-10-12 an
 * agent's `pkill -f until` stopped 14 agent threads at once. Applied by the structured manager
 * to every can_use_tool request, before the thread's own policy. A guard against a mistake, not
 * an adversary: it reads the command text, and a determined workaround is out of scope.
 */

/** Words that can stand before a command word: privilege, shell keywords, wrappers. */
const LEAD = String.raw`(?:(?:sudo|then|do|else|exec|nohup|command|time)\s+(?:-\S+\s+)*)*`;
/** The start of a command: the line start, or a separator / substitution opener before it. */
const AT_COMMAND = String.raw`(?:^|[;&|(\x60\n])\s*` + LEAD;

const RULES: RegExp[] = [
  // pkill / killall always select processes by name or pattern.
  new RegExp(AT_COMMAND + String.raw`(?:pkill|killall)\b`),
  // kill $(pgrep …) / kill `pidof …` / kill $(ps … | grep …)
  new RegExp(AT_COMMAND + String.raw`kill\b[^;&|\n]*(?:\$\(|\x60)\s*(?:pgrep|pidof|ps)\b`),
  // pgrep … | xargs kill, ps … | grep … | xargs kill
  new RegExp(String.raw`\b(?:pgrep|pidof|ps)\b[^;&\n]*\|[^;&\n]*\bxargs\b[^;&|\n]*\bkill\b`),
  // kill -1 (every process the user owns) or kill 0 (the whole process group), as the last target.
  new RegExp(AT_COMMAND + String.raw`kill(?:\s+-[A-Za-z0-9]+)*\s+(?:-1|0)\s*(?:$|[;&|)\n])`),
];

const MESSAGE =
  'Dispatch blocked this command: it signals processes by name or pattern (pkill, killall, or ' +
  'pgrep/pidof/ps feeding kill). On this machine that can stop every agent thread, because each ' +
  "Claude agent's command line holds its prompt (a broad pattern once stopped 14 agents at once). " +
  'Kill by PID instead: save the PID when you start a background process (`cmd & echo $!`), or ' +
  "find it with `pgrep -fl '<pattern>'`, check that it is yours, then run `kill <pid>`.";

/** Blank out quoted text, so a pattern only matches the command itself, not an argument. */
function withoutQuotes(command: string): string {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/** A deny decision for a Bash call that kills by name or pattern; null for anything else. */
export function broadKillDenial(toolName: string, input: unknown): { allow: false; message: string } | null {
  if (toolName !== 'Bash') return null;
  const command = (input as { command?: unknown } | undefined)?.command;
  if (typeof command !== 'string' || !command) return null;
  const text = withoutQuotes(command);
  return RULES.some((r) => r.test(text)) ? { allow: false, message: MESSAGE } : null;
}
