import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Drops (2026-11-11): the `preview` tool takes a `kind`. The checks are a module beside the MCP server,
// so they are tested here without a daemon; previews-mcp.test.ts covers the tool end to end.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const kinds = await import(path.join(REPO, 'packages/plugins/previews/mcp/kinds.mjs')) as {
  KINDS: string[];
  checkArgs(a: unknown): { kind: string | null; text: string | null; paths: string[]; fields: Record<string, unknown>; defaultTitle: string | null };
  expireSecret<T extends Record<string, unknown>>(doc: T, now?: number): T | null;
  SECRET_TTL_MS: number;
};
const { checkArgs, expireSecret, KINDS, SECRET_TTL_MS } = kinds;
const err = (a: unknown) => { try { checkArgs(a); } catch (e) { return (e as Error).message; } return null; };

describe('preview kinds: the checks of the tool arguments', () => {
  it('knows the kinds, and an unknown kind is refused with the list', () => {
    expect(KINDS).toEqual(expect.arrayContaining(['command', 'link', 'code', 'secret', 'steps', 'diff', 'table']));
    expect(err({ kind: 'video', text: 'x' })).toMatch(/unknown kind "video".*command.*link/);
    expect(err({ kind: 3, text: 'x' })).toMatch(/unknown kind/);
  });

  it('no kind: as before (text and/or paths), and the kind is not stored', () => {
    expect(checkArgs({ text: 'hello' })).toMatchObject({ kind: null, text: 'hello', paths: [], fields: {} });
    expect(err({})).toMatch(/needs text or at least one path/);
  });

  it('command: one per line of text, or a list; blank lines go; cwd is kept', () => {
    const a = checkArgs({ kind: 'command', text: 'cd ~/Sites/dispatch\n\n  ./bin/dispatch update  \n', cwd: '~/Sites/dispatch' });
    expect(a.fields).toEqual({ commands: ['cd ~/Sites/dispatch', '  ./bin/dispatch update'], cwd: '~/Sites/dispatch' });
    expect(a.text).toBe('cd ~/Sites/dispatch\n  ./bin/dispatch update');
    expect(a.defaultTitle).toBe('2 commands');
    expect(checkArgs({ kind: 'command', text: 'ls' }).defaultTitle).toBe('Command');
    const b = checkArgs({ kind: 'command', commands: ['git status', 'git log -1'] });
    expect(b.fields).toEqual({ commands: ['git status', 'git log -1'] });
    expect(b.defaultTitle).toBe('2 commands');
    expect(err({ kind: 'command' })).toMatch(/command needs `text` or `commands`/);
    expect(err({ kind: 'command', commands: ['ok', 4] })).toMatch(/each command must be a string/);
    expect(err({ kind: 'command', text: 'ls', cwd: 7 })).toMatch(/cwd must be a string/);
  });

  it('link: an http(s) url only; the host is the default title', () => {
    const a = checkArgs({ kind: 'link', url: 'https://dash.cloudflare.com/x?y=1' });
    expect(a.fields).toEqual({ url: 'https://dash.cloudflare.com/x?y=1' });
    expect(a.text).toBe('https://dash.cloudflare.com/x?y=1');
    expect(a.defaultTitle).toBe('dash.cloudflare.com');
    expect(checkArgs({ kind: 'link', text: ' http://localhost:3456 ' }).fields).toEqual({ url: 'http://localhost:3456' });
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.y', 'not a url', 'data:text/html,hi']) {
      expect(err({ kind: 'link', url: bad }), bad).toMatch(/url must be an http:\/\/ or https:\/\/ address/);
    }
    expect(err({ kind: 'link' })).toMatch(/link needs a `url`/);
  });

  it('code: text with an optional language', () => {
    expect(checkArgs({ kind: 'code', text: 'const a = 1;', language: 'ts' }).fields).toEqual({ language: 'ts' });
    expect(err({ kind: 'code' })).toMatch(/code needs `text`/);
    expect(err({ kind: 'code', text: 'x', language: 'no spaces allowed' })).toMatch(/language/);
  });

  it('secret: text only, never in the title or the note, never as a default title', () => {
    const a = checkArgs({ kind: 'secret', text: 'sk-live-abcdef123456' });
    expect(a.defaultTitle).toBe('Secret');
    expect(a.text).toBe('sk-live-abcdef123456');
    expect(err({ kind: 'secret', text: 'sk-live-abcdef123456', title: 'key sk-live-abcdef123456' })).toMatch(/must not contain the secret/);
    expect(err({ kind: 'secret', text: 'sk-live-abcdef123456', note: 'it is sk-live-abcdef123456' })).toMatch(/must not contain the secret/);
    expect(err({ kind: 'secret', text: 'tok', paths: ['a.png'] })).toMatch(/secret takes `text` only/);
    expect(err({ kind: 'secret' })).toMatch(/secret needs `text`/);
  });

  it('steps: 1 to 30, each with text and an optional command', () => {
    const a = checkArgs({ kind: 'steps', steps: [{ text: 'Open Settings' }, { text: 'Run the update', command: './bin/dispatch update' }] });
    expect(a.fields).toEqual({ steps: [{ text: 'Open Settings' }, { text: 'Run the update', command: './bin/dispatch update' }] });
    expect(a.text).toBe('1. Open Settings\n2. Run the update\n   ./bin/dispatch update');
    expect(a.defaultTitle).toBe('2 steps');
    expect(err({ kind: 'steps', steps: Array.from({ length: 31 }, (_, i) => ({ text: `s${i}` })) })).toMatch(/too many steps \(max 30\)/);
    expect(err({ kind: 'steps', steps: [] })).toMatch(/steps needs `steps`/);
    expect(err({ kind: 'steps', steps: [{ command: 'ls' }] })).toMatch(/each step needs `text`/);
    expect(err({ kind: 'steps', steps: [{ text: 'x', command: 5 }] })).toMatch(/a step's `command` must be a string/);
  });

  it('diff: text needed', () => {
    expect(checkArgs({ kind: 'diff', text: '--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y' }).defaultTitle).toBe('Diff');
    expect(err({ kind: 'diff' })).toMatch(/diff needs `text`/);
  });

  it('table: CSV text, or one .csv or .json file', () => {
    expect(checkArgs({ kind: 'table', text: 'a,b\n1,2' }).kind).toBe('table');
    expect(checkArgs({ kind: 'table', paths: ['out/data.csv'] }).paths).toEqual(['out/data.csv']);
    expect(checkArgs({ kind: 'table', paths: ['rows.json'] }).kind).toBe('table');
    expect(err({ kind: 'table', paths: ['a.png'] })).toMatch(/table needs CSV `text` or one .csv or .json file/);
    expect(err({ kind: 'table' })).toMatch(/table needs CSV `text` or one .csv or .json file/);
  });

  it('the old limits still hold for every kind', () => {
    expect(err({ kind: 'code', text: 'x'.repeat(64 * 1024 + 1) })).toMatch(/text too long/);
    expect(err({ kind: 'images', paths: Array.from({ length: 21 }, (_, i) => `${i}.png`) })).toMatch(/too many files/);
  });
});

describe('a secret expires 24 hours after it was posted', () => {
  const doc = { id: 'x', kind: 'secret', title: 'Secret', text: 'sk-1234', createdAt: '2026-11-10T10:00:00.000Z' };
  it('before 24 hours: unchanged (null)', () => {
    expect(SECRET_TTL_MS).toBe(24 * 3_600_000);
    expect(expireSecret(doc, Date.parse('2026-11-11T09:59:00Z'))).toBeNull();
  });
  it('after: the text is removed and the doc says it expired', () => {
    expect(expireSecret(doc, Date.parse('2026-11-11T10:00:01Z'))).toEqual({ ...doc, text: null, expired: true });
  });
  it('other kinds and expired secrets are left alone', () => {
    expect(expireSecret({ ...doc, kind: 'code' }, Date.parse('2027-01-01T00:00:00Z'))).toBeNull();
    expect(expireSecret({ ...doc, text: null, expired: true }, Date.parse('2027-01-01T00:00:00Z'))).toBeNull();
  });
});
