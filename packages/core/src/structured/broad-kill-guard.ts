/**
 * Refuses Bash commands that signal processes by NAME or PATTERN instead of by PID: pkill,
 * killall, kill or `xargs kill` fed by pgrep/pidof/ps, and kill -1 / kill 0. Every Claude agent
 * Dispatch runs carries its prompt in its command line, so a pattern meant for one loop can match
 * all of them — on 2026-10-12 an agent's `pkill -f until` stopped 14 agent threads at once.
 * Applied by the structured manager to every can_use_tool request, before the thread's own policy.
 *
 * A guard against a mistake, not an adversary. It reads the command the way a shell would, well
 * enough for the forms an agent writes (quotes, command substitutions, prefixes like sudo/env/
 * timeout, redirects, comments, pipelines across lines), and treats heredoc bodies as data. A
 * determined workaround (`sh -c '…'`, `bash <<EOF`, eval) is out of scope.
 */

/** Commands that wrap another command, with the options of each that take an argument. */
const WRAPPERS = new Map<string, ReadonlySet<string>>([
  ['sudo', new Set(['-u', '-g', '-h', '-p', '-C', '-U', '-r', '-t', '-D', '-R', '-T'])],
  ['env', new Set(['-u', '-C', '-S', '-P'])],
  ['time', new Set(['-o', '-f'])],
  ['nice', new Set(['-n'])],
  ['nohup', new Set()],
  ['timeout', new Set(['-s', '-k'])],
  ['command', new Set()],
  ['exec', new Set(['-a'])],
  ['builtin', new Set()],
  ['stdbuf', new Set(['-i', '-o', '-e'])],
  ['caffeinate', new Set(['-t', '-w'])],
]);
/** Deeper `$(` nesting is read as plain text: no real command nests this far, and it bounds recursion. */
const MAX_NEST = 32;
const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!']);
const PROCESS_LISTERS = new Set(['pgrep', 'pidof', 'ps']);
/** xargs options that take a separate argument (`-n 1`, `-I {}`, …). */
const XARGS_ARG_OPTS = new Set(['-I', '-J', '-L', '-n', '-P', '-s', '-E', '-d', '-R', '-S']);

type Heredoc = { word: string; tabs: boolean; expands: boolean };

/** The heredoc a line opens, if any: a `<<` outside quotes and comments (not a `<<<` here-string). */
function heredocOpener(line: string): Heredoc | null {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return null;
    if (c === '<' && line[i + 1] === '<' && line[i + 2] !== '<' && line[i - 1] !== '<') {
      const m = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|(\\?)([^\s'"<>;&|()]+))/.exec(line.slice(i));
      if (m) return { word: m[2] ?? m[3] ?? m[5], tabs: m[1] === '-', expands: m[2] === undefined && m[3] === undefined && !m[4] };
    }
  }
  return null;
}

/** The `$(…)` and `` `…` `` spans of a line, joined; '' when there are none. */
function substitutionsIn(line: string): string {
  const spans: string[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '$' && line[i + 1] === '(') {
      let parens = 0;
      let j = i + 2;
      for (; j < line.length; j++) {
        if (line[j] === '(') parens++;
        else if (line[j] === ')') { if (parens === 0) break; parens--; }
      }
      spans.push(line.slice(i, j + 1));
      i = j;
    } else if (line[i] === '`') {
      const k = line.indexOf('`', i + 1);
      const e = k < 0 ? line.length - 1 : k;
      spans.push(line.slice(i, e + 1));
      i = e;
    }
  }
  return spans.join(' ');
}

/**
 * Heredoc bodies are data written somewhere (a file, a doc), not commands. Only a body under an
 * unquoted delimiter is expanded, so its substitutions still run: those are kept, as `: $(…)`.
 */
function withoutHeredocBodies(command: string): string {
  const out: string[] = [];
  let open: Heredoc | null = null;
  for (const line of command.split('\n')) {
    if (open) {
      if ((open.tabs ? line.replace(/^\t+/, '') : line) === open.word) { open = null; continue; }
      if (open.expands) { const subs = substitutionsIn(line); if (subs) out.push(`: ${subs}`); }
      continue;
    }
    out.push(line);
    open = heredocOpener(line);
  }
  return out.join('\n');
}

/**
 * The executable text of a command: quoted literals become `''`/`""` (one token each), command
 * substitutions — also inside double quotes — stay, escapes and comments go.
 */
function codeText(s: string): string {
  const n = s.length;
  // Scan code from `i`; with `inSub`, stop after the `)` that closes a `$(`. `nest` counts open `$(`.
  function scan(i: number, inSub: boolean, nest: number): [string, number] {
    let out = '';
    let depth = 0;
    while (i < n) {
      const c = s[i];
      if (c === '\\') { out += s[i + 1] === '\n' ? ' ' : '_'; i += 2; continue; }
      if (c === "'") { const k = s.indexOf("'", i + 1); out += "''"; i = k < 0 ? n : k + 1; continue; }
      if (c === '"') { const [kept, k] = doubleQuoted(i + 1, nest); out += kept; i = k; continue; }
      if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) { while (i < n && s[i] !== '\n') i++; continue; }
      if (c === '$' && s[i + 1] === '(' && nest < MAX_NEST) { const [code, k] = scan(i + 2, true, nest + 1); out += `$(${code})`; i = k; continue; }
      if (inSub && c === '(') depth++;
      if (inSub && c === ')') { if (depth === 0) return [out, i + 1]; depth--; }
      out += c;
      i++;
    }
    return [out, i];
  }
  // Inside "…": keep only the substitutions; the rest is one literal token.
  function doubleQuoted(i: number, nest: number): [string, number] {
    let kept = '""';
    while (i < n && s[i] !== '"') {
      if (s[i] === '\\') { i += 2; continue; }
      if (s[i] === '$' && s[i + 1] === '(' && nest < MAX_NEST) { const [code, k] = scan(i + 2, true, nest + 1); kept += ` $(${code}) `; i = k; continue; }
      if (s[i] === '`') { const k = s.indexOf('`', i + 1); const e = k < 0 ? n : k; kept += ` \`${s.slice(i + 1, e)}\` `; i = e + 1; continue; }
      i++;
    }
    return [kept, i + 1];
  }
  return scan(0, false, 0)[0];
}

/** Replace each `$(…)` / `` `…` `` with a ` __S<n>__ ` token, collecting the bodies. */
function extractSubstitutions(code: string, bodies: string[]): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    if (code[i] === '$' && code[i + 1] === '(') {
      let depth = 0;
      let j = i + 2;
      for (; j < code.length; j++) {
        if (code[j] === '(') depth++;
        else if (code[j] === ')') { if (depth === 0) break; depth--; }
      }
      bodies.push(code.slice(i + 2, j));
      out += ` __S${bodies.length - 1}__ `;
      i = j + 1;
    } else if (code[i] === '`') {
      const k = code.indexOf('`', i + 1);
      const e = k < 0 ? code.length : k;
      bodies.push(code.slice(i + 1, e));
      out += ` __S${bodies.length - 1}__ `;
      i = e + 1;
    } else {
      out += code[i];
      i++;
    }
  }
  return out;
}

/** A stage's command word (its basename) and arguments, past assignments, keywords, wrappers and redirects. */
function commandOf(stage: string): { name: string; args: string[] } | null {
  // Subshell parens and group braces are not part of a word; `-I{}` and `{}` (xargs) are.
  const raw = stage.replace(/[()]/g, ' ').trim().split(/\s+/).filter((t) => t && t !== '{' && t !== '}');
  // Drop redirects: `2>/dev/null`, `>out`, `2>&1`, and a bare operator with its target (`2> file`).
  const tokens: string[] = [];
  for (let k = 0; k < raw.length; k++) {
    const t = raw[k];
    if (/^\d*(?:>>?|<|&>>?|>&)$/.test(t)) { k++; continue; }
    if (/^\d*(?:>>?|<(?!<<)|&>>?|>&)\S+$/.test(t)) continue;
    tokens.push(t);
  }
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const base = t.slice(t.lastIndexOf('/') + 1);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || KEYWORDS.has(t)) { i++; continue; }
    const argOpts = WRAPPERS.get(base);
    if (argOpts) {
      i++;
      while (i < tokens.length && tokens[i].startsWith('-')) {
        if (base === 'command' && (tokens[i] === '-v' || tokens[i] === '-V')) return null; // a lookup, not a run
        if (argOpts.has(tokens[i])) i++;
        i++;
      }
      if (base === 'timeout' && /^\d/.test(tokens[i] ?? '')) i++;
      continue;
    }
    return { name: base, args: tokens.slice(i + 1) };
  }
  return null;
}

/** kill's targets include -1 (every process the user owns) or 0 (the whole process group). */
function killsEverything(args: string[]): boolean {
  let signalGiven = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') return args.slice(k + 1).some((t) => t === '-1' || t === '0');
    if (!signalGiven && (a === '-l' || a === '-L')) return false; // lists signals
    if (!signalGiven && (a === '-s' || a === '-n')) { signalGiven = true; k++; continue; }
    if (!signalGiven && /^-[A-Za-z0-9]+$/.test(a)) { signalGiven = true; continue; }
    return args.slice(k).some((t) => t === '-1' || t === '0');
  }
  return false;
}

/** The command xargs runs (its basename), past xargs's own options and any wrapper (`xargs sudo kill`). */
function xargsCommand(args: string[]): string | undefined {
  let k = 0;
  while (k < args.length && args[k].startsWith('-')) { if (XARGS_ARG_OPTS.has(args[k])) k++; k++; }
  return commandOf(args.slice(k).join(' '))?.name;
}

/** True when `code` (already through codeText) holds a kill by name or pattern. */
function isBroadKill(code: string, nest = 0): boolean {
  const bodies: string[] = [];
  const flat = extractSubstitutions(code, bodies);
  // A substitution runs too: `echo "$(pkill -f x)"`.
  if (nest < MAX_NEST && bodies.some((b) => isBroadKill(b, nest + 1))) return true;
  // Which substitutions list processes: `$(pgrep …)`, `$(ps … | grep …)` — read from their first
  // command, which may follow a newline (`$(⏎pgrep -f x⏎)`).
  const listsProcesses = bodies.map((b) => {
    const pipelines = extractSubstitutions(b, []).split(/\|\||&&|[;\n]|(?<![<>])&(?![>&])/);
    const first = pipelines.map((p) => p.trim()).find(Boolean)?.split('|')[0] ?? '';
    return PROCESS_LISTERS.has(commandOf(first)?.name ?? '');
  });
  const fedByLister = (stage: string) => [...stage.matchAll(/__S(\d+)__/g)].some((m) => listsProcesses[Number(m[1])]);

  const joined = flat.replace(/(\|\||&&|\|)[ \t]*\n/g, '$1 '); // a pipeline continued on the next line
  for (const pipeline of joined.split(/\|\||&&|[;\n]|(?<![<>])&(?![>&])/)) {
    let upstreamLists = false;
    for (const stage of pipeline.split('|')) {
      const cmd = commandOf(stage);
      if (!cmd) continue;
      if (cmd.name === 'pkill' || cmd.name === 'killall') return true;
      if (cmd.name === 'kill' && (killsEverything(cmd.args) || fedByLister(stage))) return true;
      if (cmd.name === 'xargs' && xargsCommand(cmd.args) === 'kill' && (upstreamLists || fedByLister(stage))) return true;
      if (PROCESS_LISTERS.has(cmd.name)) upstreamLists = true;
    }
  }
  return false;
}

const MESSAGE =
  'Dispatch blocked this command: it signals processes by name or pattern (pkill, killall, ' +
  'pgrep/pidof/ps feeding kill, or kill -1 / kill 0). On this machine that can stop every agent ' +
  "thread, because each Claude agent's command line holds its prompt (a broad pattern once stopped " +
  '14 agents at once). Kill by PID instead: save the PID when you start a background process ' +
  "(`cmd & echo $!`), or find it with `pgrep -fl '<pattern>'`, check that it is yours, then run " +
  '`kill <pid>`.';

/** A deny decision for a Bash call that kills by name or pattern; null for anything else. */
export function broadKillDenial(toolName: string, input: unknown): { allow: false; message: string } | null {
  if (toolName !== 'Bash') return null;
  const command = (input as { command?: unknown } | undefined)?.command;
  if (typeof command !== 'string' || !command) return null;
  try {
    return isBroadKill(codeText(withoutHeredocBodies(command))) ? { allow: false, message: MESSAGE } : null;
  } catch {
    // This runs inside the daemon's message handling: a parse failure must never escape. Fail open.
    return null;
  }
}
