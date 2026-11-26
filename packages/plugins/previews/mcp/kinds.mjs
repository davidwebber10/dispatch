// The kinds of a drop (Drops, 2026-11-11): the checks of the `preview` tool's arguments, apart from the
// server so the tests read them without a daemon. A kind decides how the card looks in the app; the
// document keeps `kind` and the kind's own fields beside the old ones (title, note, text, files), so an
// older app still shows the text.
//
// No `kind` is the old tool: text and/or paths, and the app infers the look.
//
// Every refusal names the exact field to pass, so a model that guessed a field can correct itself.
// `code` takes `text`, or ONE file in `paths`: the server reads that file into `text` (a source file
// such as .ts is not a type the Inbox stores, so it never travels as an attachment).
import fs from 'node:fs';
import path from 'node:path';

export const KINDS = ['command', 'link', 'code', 'secret', 'steps', 'diff', 'table', 'doc', 'text', 'images', 'files'];
export const MAX_FILES = 20;
export const MAX_TEXT = 64 * 1024;
export const MAX_STEPS = 30;
const MAX_COMMANDS = 50;
const MAX_SECRET = 4096;
/** A secret's text is removed this long after it was posted. */
export const SECRET_TTL_MS = 24 * 3_600_000;

const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
const fail = (m) => { throw new Error(m); };
/** The language of a code file, from its extension; null when unknown. */
const LANGUAGE_BY_EXT = {
  ts: 'ts', tsx: 'tsx', js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', json: 'json', py: 'python', rb: 'ruby',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp',
  php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  html: 'html', css: 'css', scss: 'scss', md: 'markdown', xml: 'xml', tf: 'hcl', lua: 'lua', r: 'r',
};
export function languageOf(file) {
  const ext = path.extname(String(file)).slice(1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(LANGUAGE_BY_EXT, ext) ? LANGUAGE_BY_EXT[ext] : null;
}

/**
 * Read a code file for kind=code: a regular text file inside `cwd` (the thread's folder), at most
 * MAX_TEXT. Throws an Error with a plain message.
 */
export function readCodeFile(p, cwd = process.cwd()) {
  const root = fs.realpathSync(cwd);
  let real;
  try { real = fs.realpathSync(path.resolve(cwd, p.trim())); } catch { fail(`code: cannot read "${p}" (no such file in this project)`); }
  if (real !== root && !real.startsWith(root + path.sep)) fail(`code: "${p}" is outside this project; pass the snippet in \`text\` instead`);
  const st = fs.statSync(real);
  if (!st.isFile()) fail(`code: "${p}" is not a file`);
  if (st.size > MAX_TEXT) fail('code: the file is too long (max 64 KB); pass the part that matters in `text`');
  const body = fs.readFileSync(real, 'utf8');
  if (body.includes('\u0000')) fail(`code: "${p}" is not a text file`);
  return body;
}

const plural = (n, one) => (n === 1 ? one.charAt(0).toUpperCase() + one.slice(1) : `${n} ${one}s`);

/**
 * Check the tool's arguments. Answers `{ kind, text, paths, fields, defaultTitle }`: `kind` is null when
 * none was given; `fields` are the kind's own document fields; `text` is what the document's `text` holds
 * (the copyable form, so search and an older app keep working). Throws an Error with a plain message.
 */
export function checkArgs(args, { cwd = process.cwd(), readFile = readCodeFile } = {}) {
  const a = args && typeof args === 'object' ? args : {};
  const kind = a.kind === undefined || a.kind === null ? null : a.kind;
  if (kind !== null && (typeof kind !== 'string' || !KINDS.includes(kind))) fail(`unknown kind "${String(kind)}" (use one of: ${KINDS.join(', ')})`);
  let text = str(a.text);
  if (text && text.length > MAX_TEXT) fail('text too long (max 64 KB)');
  const paths = Array.isArray(a.paths) ? [...a.paths] : [];
  if (paths.length > MAX_FILES) fail(`too many files (max ${MAX_FILES})`);
  for (const p of paths) if (typeof p !== 'string' || !p.trim()) fail('each path must be a non-empty string');
  const fields = {};
  let defaultTitle = null;
  const needText = (what) => { if (!text) fail(`${kind} needs \`text\` (${what})`); };

  switch (kind) {
    case null:
      if (!text && paths.length === 0) fail('a preview needs `text` or at least one file in `paths`');
      break;
    case 'command': {
      let list;
      if (a.commands !== undefined) {
        if (!Array.isArray(a.commands)) fail('`commands` must be a list of strings');
        for (const c of a.commands) if (typeof c !== 'string') fail('each command must be a string');
        list = a.commands;
      } else list = text ? text.split(/\r?\n/) : [];
      const commands = list.map((c) => c.replace(/\s+$/, '')).filter((c) => c.trim());
      if (commands.length === 0) fail('a command needs `text` or `commands` (one command per line)');
      if (commands.length > MAX_COMMANDS) fail(`too many commands (max ${MAX_COMMANDS})`);
      text = commands.join('\n');
      if (text.length > MAX_TEXT) fail('text too long (max 64 KB)');
      fields.commands = commands;
      if (a.cwd !== undefined && a.cwd !== null) {
        if (typeof a.cwd !== 'string') fail('cwd must be a string');
        if (a.cwd.trim()) fields.cwd = a.cwd.trim().slice(0, 1000);
      }
      defaultTitle = plural(commands.length, 'command');
      break;
    }
    case 'link': {
      const raw = str(a.url) ?? text;
      if (!raw) fail('a link needs `url` (an http:// or https:// address)');
      let u;
      try { u = new URL(raw.trim()); } catch { u = null; }
      if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) fail('url must be an http:// or https:// address');
      const url = raw.trim();
      if (url.length > 8192) fail('url too long (max 8 KB)');
      fields.url = url;
      text = url;
      defaultTitle = u.host;
      break;
    }
    case 'code':
      if (!text) {
        // The snippet from ONE file of the project: read into `text`; the file is not attached.
        if (paths.length !== 1) fail('code needs `text` (the snippet), or exactly one file in `paths` to read it from');
        const file = paths[0].trim();
        text = str(readFile(file, cwd));
        if (!text) fail(`code: "${file}" is empty; pass the snippet in \`text\``);
        if (text.length > MAX_TEXT) fail('text too long (max 64 KB)');
        paths.splice(0, 1);
        if (a.language === undefined || a.language === null) { const lang = languageOf(file); if (lang) fields.language = lang; }
        defaultTitle = path.basename(file);
      }
      if (a.language !== undefined && a.language !== null) {
        if (typeof a.language !== 'string' || !/^[A-Za-z0-9+#._-]{1,40}$/.test(a.language.trim())) fail('language must be a short name such as ts, python or bash');
        fields.language = a.language.trim();
      }
      defaultTitle = defaultTitle || 'Code';
      break;
    case 'secret':
      if (!text) fail('a secret needs `text` (the value)');
      if (paths.length) fail('a secret takes `text` only, no paths');
      if (text.length > MAX_SECRET) fail('a secret is at most 4 KB');
      for (const k of ['title', 'note']) if (typeof a[k] === 'string' && a[k].includes(text.trim())) fail(`the ${k} must not contain the secret`);
      defaultTitle = 'Secret';
      break;
    case 'steps': {
      if (!Array.isArray(a.steps) || a.steps.length === 0) fail('steps needs `steps`: a list of { text, command? } (not `text`)');
      if (a.steps.length > MAX_STEPS) fail(`too many steps (max ${MAX_STEPS})`);
      const steps = a.steps.map((s) => {
        if (!s || typeof s !== 'object' || !str(s.text)) fail('each step needs `text`');
        if (s.command !== undefined && s.command !== null && typeof s.command !== 'string') fail("a step's `command` must be a string");
        const step = { text: s.text.trim().slice(0, 2000) };
        if (str(s.command)) step.command = s.command.replace(/\s+$/, '').slice(0, 4000);
        return step;
      });
      fields.steps = steps;
      text = steps.map((s, i) => `${i + 1}. ${s.text}${s.command ? `\n   ${s.command}` : ''}`).join('\n');
      if (text.length > MAX_TEXT) fail('text too long (max 64 KB)');
      defaultTitle = plural(steps.length, 'step');
      break;
    }
    case 'diff':
      needText('a unified diff');
      defaultTitle = 'Diff';
      break;
    case 'table': {
      const tablePaths = paths.filter((p) => /\.(csv|json)$/i.test(p.trim()));
      if (!text && tablePaths.length !== 1) fail('a table needs CSV `text` or one .csv or .json file');
      defaultTitle = 'Table';
      break;
    }
    case 'doc':
      needText('markdown');
      break;
    case 'text':
      needText('the text to show');
      break;
    case 'images':
    case 'files':
      if (paths.length === 0) fail(`${kind} needs \`paths\`: at least one file of this project`);
      break;
    default:
      break;
  }
  return { kind, text, paths, fields, defaultTitle };
}

/** A secret's document past its 24 hours, with the text removed; null when nothing is to change. */
export function expireSecret(doc, now = Date.now()) {
  if (!doc || doc.kind !== 'secret' || doc.text === null || doc.text === undefined) return null;
  const t = Date.parse(doc.createdAt);
  if (Number.isNaN(t) || now - t <= SECRET_TTL_MS) return null;
  return { ...doc, text: null, expired: true };
}
