// W3-A acceptance, kept as a guard: startServer stays under 80 lines, no wire* function is over 200 lines,
// and the daemon files hold every setInterval of the start path in the one list of timers.ts.
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = path.resolve(import.meta.dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(src, rel), 'utf8');
const daemonFiles = fs.readdirSync(path.join(src, 'daemon')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

/** The line count of a top-level `export function name(` up to its closing brace in column 0. */
function functionLines(text: string, name: string): number {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^export (async )?function ${name}\\b`).test(l));
  if (start < 0) throw new Error(`no function ${name}`);
  const end = lines.findIndex((l, n) => n > start && l === '}');
  return end - start + 1;
}

describe('the shape of the daemon files', () => {
  test('startServer is under 80 lines', () => {
    expect(functionLines(read('server.ts'), 'startServer')).toBeLessThan(80);
  });

  test('no wire* function is over 200 lines, and each wire file exists', () => {
    const found: string[] = [];
    for (const f of daemonFiles) {
      const text = read(`daemon/${f}`);
      for (const m of text.matchAll(/^export (?:async )?function (wire[A-Za-z]+)\b/gm)) {
        found.push(m[1]);
        expect(functionLines(text, m[1]), `${f}: ${m[1]}`).toBeLessThanOrEqual(200);
      }
    }
    expect(found).toEqual(expect.arrayContaining(['wireAuth', 'wireLimits', 'wirePty', 'wireSpawnEnv', 'wirePlugins', 'wireHarnesses', 'wireSessionService']));
  });

  test('server.ts and the daemon files call setInterval only in timers.ts', () => {
    const withInterval = ['server.ts', ...daemonFiles.map((f) => `daemon/${f}`)].filter((f) => /\bsetInterval\(/.test(read(f)));
    expect(withInterval).toEqual(['daemon/timers.ts']);
  });

  test('server.ts builds nothing itself: no service is constructed outside daemon/', () => {
    expect(read('server.ts')).not.toMatch(/new (SessionService|StatusService|AgentService|RolesService|PluginRegistry|UsageLimitService|EndlessService|PTYManager)\(/);
  });
});
