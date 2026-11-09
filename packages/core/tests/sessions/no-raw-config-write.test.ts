import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// W2-A guard: `terminals.config` has one writer, ThreadConfigStore (sessions/thread-config.ts).
// A direct call of the raw write replaces the whole column from a copy and can drop another
// writer's key: the lost-update bug class. Product code names the keys it changes with store.patch.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const ALLOWED = new Set(['sessions/thread-config.ts', 'db/terminals.ts']);
// The raw write under its current name and under the name it had before W2-A.
const RAW_CALL = /\b(writeConfigRaw|updateConfig)\s*\(/;
// A direct SQL write of the column is the same thing by another road.
const RAW_SQL = /UPDATE\s+terminals\s+SET[^;`'"]*\bconfig\s*=/i;

function productFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) productFiles(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('no raw config write outside the config store', () => {
  const files = productFiles(SRC);

  it('finds the product files', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith(path.join('sessions', 'service.ts')))).toBe(true);
  });

  it('no file outside sessions/thread-config.ts and db/terminals.ts calls the raw write function', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (ALLOWED.has(rel)) continue;
      const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        // `updateConfig` is a common method name: only a call on the terminals module counts.
        const m = RAW_CALL.exec(line);
        if (m && (m[1] === 'writeConfigRaw' || /terminalsDb\.updateConfig/.test(line))) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        if (RAW_SQL.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the raw write exists under its internal name only', async () => {
    const terminalsDb = await import('../../src/db/terminals.js') as Record<string, unknown>;
    expect(typeof terminalsDb.writeConfigRaw).toBe('function');
    expect(terminalsDb.updateConfig).toBeUndefined();
  });

  it('the guard itself sees a raw call (a file with one is reported)', () => {
    expect(RAW_CALL.test('terminalsDb.writeConfigRaw(this.db, id, cfg);')).toBe(true);
    expect(RAW_SQL.test("db.prepare('UPDATE terminals SET config = ? WHERE id = ?')")).toBe(true);
    expect(RAW_SQL.test("db.prepare('UPDATE terminals SET status = ? WHERE id = ?')")).toBe(false);
  });
});
