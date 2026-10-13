/**
 * One-time import (spec 2026-10-13 section 6.5): on first start, each project's shared
 * MEMORY.md and its open ledger items become one `note` message per project.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import * as ledgerDb from '../db/ledger.js';
import { claudeMemoryProjectDir, sharedProjectMemoryDir } from '../overseer/memory-scope.js';
import type { EndlessStore } from './store.js';
import type { LogInput } from './log.js';

export function importOnce(o: { db: Database.Database; store: EndlessStore; home: string; log: (input: LogInput) => unknown }): number {
  if (o.store.getState('imported') === '1') return 0;
  let written = 0;
  for (const s of sessionsDb.list(o.db)) {
    const parts: string[] = [];
    const where = claudeMemoryProjectDir(s.working_dir);
    if (where.dir) {
      try {
        const text = fs.readFileSync(path.join(sharedProjectMemoryDir(o.home, where.dir), 'MEMORY.md'), 'utf8').trim();
        if (text) parts.push(`MEMORY.md:\n${text}`);
      } catch { /* no memory file for this project */ }
    }
    const open = ledgerDb.listBySession(o.db, s.id).filter((it) => it.status === 'open');
    if (open.length) parts.push(`Open items:\n${open.map((it) => `- N${it.seq} ${it.title ?? it.text}`).join('\n')}`);
    if (!parts.length) continue;
    o.log({ kind: 'note', project: s.id, text: `Memories imported for ${s.name} (${s.working_dir}):\n\n${parts.join('\n\n')}` });
    written++;
  }
  o.store.setState('imported', '1');
  return written;
}
