import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveCredential, keyAllowedFor } from '../../src/auth/credential.js';
// @ts-expect-error plain .mjs helper without types
import { authHeaders, keyAllowedFor as mjsAllowedFor } from '../../scripts/key-header.mjs';

// Per-thread keys, 13c: the Codex notify helper and the Grok hook helper send the thread key
// only when it is a dtk_ key from DISPATCH_AUTH (or a key file) AND the target URL is under
// DISPATCH_API. The key never appears in argv.

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');
const KEY = 'dtk_' + 'k'.repeat(43);
const OTHER = 'dtk_' + 'o'.repeat(43);
const SHELL = 'dsk_' + 's'.repeat(43);

let server: http.Server;
let port = 0;
let seen: { auth: string | undefined; url: string }[] = [];
let sandbox: string;

beforeAll(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-hooks-'));
  server = http.createServer((req, res) => {
    seen.push({ auth: req.headers.authorization, url: req.url ?? '' });
    req.resume();
    req.on('end', () => { res.statusCode = 204; res.end(); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(sandbox, { recursive: true, force: true });
});
beforeEach(() => { seen = []; });

const base = () => `http://127.0.0.1:${port}`;

function run(script: string, args: string[], env: Record<string, string>, stdin?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // A clean env: nothing of the test runner's own DISPATCH_* variables leaks in.
    const child = spawn(process.execPath, [path.join(scripts, script), ...args], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('exit', () => resolve());
    child.stdin.end(stdin ?? '');
  });
}
const notify = (url: string, env: Record<string, string>) => run('codex-notify.mjs', [url, '{"type":"agent-turn-complete"}'], env);
const grok = (url: string, env: Record<string, string>) => run('grok-hook.mjs', [url], env, '{"hook_event_name":"Stop"}');

for (const [name, fire] of [['codex-notify.mjs', notify], ['grok-hook.mjs', grok]] as const) {
  describe(name, () => {
    it('sends the key from DISPATCH_AUTH to the URL under DISPATCH_API', async () => {
      await fire(`${base()}/api/events/x/t1`, { DISPATCH_AUTH: KEY, DISPATCH_API: base() });
      expect(seen).toHaveLength(1);
      expect(seen[0].auth).toBe(`Bearer ${KEY}`);
    });

    it('sends the key from the file in DISPATCH_AUTH_FILE', async () => {
      const f = path.join(sandbox, 'key-file');
      fs.writeFileSync(f, `${KEY}\n`, { mode: 0o600 });
      await fire(`${base()}/api/events/x/t1`, { DISPATCH_AUTH_FILE: f, DISPATCH_API: base() });
      expect(seen[0].auth).toBe(`Bearer ${KEY}`);
    });

    it('sends no header when DISPATCH_API is unset', async () => {
      await fire(`${base()}/api/events/x/t1`, { DISPATCH_AUTH: KEY });
      expect(seen).toHaveLength(1);
      expect(seen[0].auth).toBeUndefined();
    });

    it('sends no header when DISPATCH_API names another port', async () => {
      await fire(`${base()}/api/events/x/t1`, { DISPATCH_AUTH: KEY, DISPATCH_API: `http://127.0.0.1:${port + 1}` });
      expect(seen[0].auth).toBeUndefined();
    });

    it('sends no header when the URL is outside the base path of DISPATCH_API', async () => {
      await fire(`${base()}/api/events/x/t1`, { DISPATCH_AUTH: KEY, DISPATCH_API: `${base()}/prefix` });
      expect(seen[0].auth).toBeUndefined();
    });

    it('sends the key under a base path', async () => {
      await fire(`${base()}/prefix/api/events/x/t1`, { DISPATCH_AUTH: KEY, DISPATCH_API: `${base()}/prefix` });
      expect(seen[0].auth).toBe(`Bearer ${KEY}`);
    });

    it('sends no header for a shell key, a missing file or no key at all', async () => {
      await fire(`${base()}/a`, { DISPATCH_AUTH: SHELL, DISPATCH_API: base() });
      await fire(`${base()}/b`, { DISPATCH_AUTH_FILE: path.join(sandbox, 'nope'), DISPATCH_API: base() });
      await fire(`${base()}/c`, { DISPATCH_API: base() });
      expect(seen).toHaveLength(3);
      expect(seen.every((s) => s.auth === undefined)).toBe(true);
    });

    it('holds no key in argv: the key is read from the environment only', async () => {
      // the argv the helper receives is the URL (and the payload); the test passes no key in it
      const argv = [`${base()}/api/events/x/t1`, '{}'];
      expect(argv.join(' ')).not.toMatch(/d[tcs]k_/);
      const src = fs.readFileSync(path.join(scripts, name), 'utf8');
      expect(src).not.toMatch(/process\.argv[^;]*(KEY|AUTH)/);
    });
  });
}

// The .mjs helpers cannot import TypeScript, so key-header.mjs repeats the credential rule and the
// destination rule. This table runs both implementations over the same inputs.
describe('key-header.mjs parity with auth/credential.ts', () => {
  const keyFile = () => {
    const f = path.join(sandbox, 'parity-key');
    fs.writeFileSync(f, `${KEY}\n`, { mode: 0o600 });
    return f;
  };
  const urls = [
    'http://127.0.0.1:3000/api/events/x/t', 'http://127.0.0.1:3000', 'http://127.0.0.1:3000/prefix/api/x',
    'http://127.0.0.1:3001/api/x', 'http://localhost:3000/api/x', 'https://127.0.0.1:3000/api/x',
    'http://user:pw@127.0.0.1:3000/api/x', 'http://127.0.0.1:3000/prefixed/api', 'not a url', '',
  ];
  const apis: (string | undefined)[] = [undefined, '', 'http://127.0.0.1:3000', 'http://127.0.0.1:3000/', 'http://127.0.0.1:3000/prefix', 'junk'];

  it('keyAllowedFor agrees on every url and DISPATCH_API', () => {
    for (const api of apis) {
      for (const url of urls) {
        const env = api === undefined ? {} : { DISPATCH_API: api };
        expect(mjsAllowedFor(url, env), `${api} | ${url}`).toBe(keyAllowedFor(url, env));
      }
    }
  });

  it('a header is sent exactly when resolveCredential gives a thread key (dtk_) and the url is allowed', () => {
    const f = keyFile();
    const envs: Record<string, string>[] = [
      { DISPATCH_AUTH: KEY }, { DISPATCH_AUTH: OTHER }, { DISPATCH_AUTH: SHELL }, { DISPATCH_AUTH: 'junk' },
      { DISPATCH_AUTH: 'junk', DISPATCH_AUTH_FILE: f }, { DISPATCH_AUTH_FILE: f },
      { DISPATCH_AUTH_FILE: path.join(sandbox, 'missing') }, { DISPATCH_TERMINAL_ID: 't' }, {},
      { DISPATCH_AUTH: KEY, DISPATCH_AUTH_FILE: f }, { DISPATCH_AUTH: SHELL, DISPATCH_AUTH_FILE: f },
    ];
    for (const e of envs) {
      for (const api of [undefined, 'http://127.0.0.1:3000']) {
        for (const url of ['http://127.0.0.1:3000/api/x', 'http://127.0.0.1:3001/api/x']) {
          const env: Record<string, string> = { ...e, ...(api ? { DISPATCH_API: api } : {}) };
          const cred = resolveCredential({ env, purpose: 'mcp', readOwnerToken: () => { throw new Error('owner token must not be read'); } });
          const expected = cred.mode === 'thread' && keyAllowedFor(url, env) ? cred.header : undefined;
          const got = authHeaders(url, env).authorization as string | undefined;
          expect(got, `${JSON.stringify(e)} | ${api} | ${url}`).toBe(expected);
        }
      }
    }
  });
});
