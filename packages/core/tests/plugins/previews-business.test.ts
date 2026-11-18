// The Inbox (previews plugin) for a business person on a hosted box: Send a secret is not part of that
// workspace, so the MCP server offers no `inbox_secret` (not listed, refused when called), the `preview`
// description does not send the person to it, and the plugin's instructions leave its paragraph out.
// A developer box and a local install keep all of it.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { instructionsFor } from '../../src/plugins/registry.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SERVER = path.join(REPO, 'packages/plugins/previews/mcp/server.mjs');
const INSTRUCTIONS = path.join(REPO, 'packages/plugins/previews/instructions.md');

/** Start the server with `env`, send `requests`, return the answers in order. */
async function talk(env: Record<string, string>, requests: unknown[]): Promise<any[]> {
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH ?? '', DISPATCH_AUTH: 'k', DISPATCH_PORT: '9', ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
  const rl = readline.createInterface({ input: child.stdout! });
  const answers: any[] = [];
  const done = new Promise<void>((resolve) => {
    rl.on('line', (line) => { answers.push(JSON.parse(line)); if (answers.length === requests.length) resolve(); });
  });
  for (const r of requests) child.stdin!.write(JSON.stringify(r) + '\n');
  await done;
  child.kill();
  return answers;
}

const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const CALL = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'inbox_secret', arguments: { id: 'K7Q2M4', reveal: true } } };

describe('the Inbox MCP server and Send a secret', () => {
  it('a business person on a hosted box: no inbox_secret, refused when called, no hint in preview', async () => {
    const [list, call] = await talk({ DISPATCH_HOSTED: '1', DISPATCH_BUSINESS: '1' }, [LIST, CALL]);
    const names = list.result.tools.map((t: any) => t.name);
    expect(names).toEqual(['preview']);
    const preview = list.result.tools.find((t: any) => t.name === 'preview');
    expect(preview.description).not.toMatch(/Send a secret|inbox_secret/);
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toMatch(/Unknown tool: inbox_secret/);
  });

  it('a developer on a hosted box and a local install keep the tool and the hint', async () => {
    const envs: Record<string, string>[] = [{ DISPATCH_HOSTED: '1' }, {}, { DISPATCH_BUSINESS: '1' }];
    for (const env of envs) {
      const [list] = await talk(env, [LIST]);
      const names = list.result.tools.map((t: any) => t.name);
      expect(names).toEqual(['preview', 'inbox_secret']);
      expect(list.result.tools[0].description).toMatch(/Send a secret/);
    }
  });

  it('the plugin instructions leave the Send a secret paragraph out for a business person only', () => {
    const text = fs.readFileSync(INSTRUCTIONS, 'utf8');
    const business = instructionsFor(text, true);
    const other = instructionsFor(text, false);
    expect(business).not.toMatch(/Send a secret|inbox_secret/);
    expect(business).toMatch(/Inbox/);
    expect(other).toMatch(/Send a secret/);
    expect(other).toMatch(/inbox_secret/);
    expect(other).not.toMatch(/not-business/);
  });
});
