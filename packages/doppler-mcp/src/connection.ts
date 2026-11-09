import fs from 'node:fs';
import path from 'node:path';
import { usableToken } from './doppler-client.js';

export type Connection =
  | { ok: true; token: string; project?: string; config?: string; readOnly: boolean }
  | { ok: false; error: string };

/** The connection file that Dispatch saves (mode 0600) in its data directory. */
const FILE = 'doppler.json';
const NO_TOKEN = 'no Doppler token: the saved connection has none and DOPPLER_TOKEN is not set';

const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Where the token, the project, the config and the read-only flag come from.
 *
 * With `--secrets-dir <dir>` the server reads the connection that Dispatch saved in that
 * directory, as the integration launcher does. The MCP config and the CLI's environment then
 * carry no token. A value that the file lacks comes from the environment.
 *
 * With no flag the environment is the only source (a standalone install).
 *
 * Every error is a fixed line: it never quotes the token, the file or an exception.
 */
export function resolveConnection(argv: string[], env: NodeJS.ProcessEnv): Connection {
  const at = argv.indexOf('--secrets-dir');
  let saved: Record<string, unknown> = {};
  if (at >= 0) {
    const dir = argv[at + 1];
    if (!dir || dir.startsWith('--')) return { ok: false, error: 'usage: doppler-mcp [--secrets-dir <dir>]' };
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
      if (parsed && typeof parsed === 'object') saved = parsed as Record<string, unknown>;
    } catch { /* no file, or not JSON: the environment may still hold a connection */ }
    if (saved.enabled === false) return { ok: false, error: 'Doppler is turned off in Dispatch' };
  }
  const raw = text(saved.token) ?? env.DOPPLER_TOKEN;
  if (!raw) return { ok: false, error: at >= 0 ? NO_TOKEN : 'DOPPLER_TOKEN is required' };
  const token = usableToken(raw);
  if (!token) return { ok: false, error: 'the Doppler token is not usable: it is blank, or it contains a CR, LF, or NUL character' };
  return {
    ok: true,
    token,
    project: text(saved.project) ?? text(env.DOPPLER_PROJECT),
    config: text(saved.config) ?? text(env.DOPPLER_CONFIG),
    readOnly: typeof saved.readOnly === 'boolean' ? saved.readOnly : env.DOPPLER_READ_ONLY === '1',
  };
}
