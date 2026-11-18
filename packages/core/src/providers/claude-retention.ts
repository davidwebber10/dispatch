// packages/core/src/providers/claude-retention.ts
//
// Claude Code deletes a conversation's transcript when it is older than `cleanupPeriodDays` (default
// 30, by file mtime), so a long-lived Dispatch thread that sat idle for a month lost its history and
// could no longer be resumed. The cleanup is run by ANY claude process, including the person's own
// terminal sessions, and it reads the settings of THAT process: a flag on Dispatch's spawns alone does
// not protect against it. (Measured in Claude Code 2.1.326: the cleanup reads `cleanupPeriodDays` from
// the enabled settings sources and skips itself when it cannot determine the value.) So the daemon puts
// the value into the user's own settings file, once, at start.
//
// Never changes a value the person set. Keeps the rest of the file. A missing config folder is left
// alone (Claude is not set up here); a missing file is created; an unreadable, invalid or non-object
// file is not touched at all.

import fs from 'node:fs';
import path from 'node:path';
import { primaryClaudeConfigDir } from '../auth/claude-config-dirs.js';
import { TRANSCRIPT_RETENTION_DAYS } from './claude-code.js';

export type RetentionResult = 'added' | 'created' | 'kept' | 'no-claude-dir' | 'invalid-file' | 'error';

export function ensureClaudeTranscriptRetention(configDir: string = primaryClaudeConfigDir(), days: number = TRANSCRIPT_RETENTION_DAYS): RetentionResult {
  try {
    if (!fs.existsSync(configDir)) return 'no-claude-dir';
    const link = path.join(configDir, 'settings.json');
    let target = link;
    try { target = fs.realpathSync(link); } catch { /* no file yet: create it at the link path */ }
    let obj: Record<string, unknown> = {};
    let mode = 0o600;
    let created = true;
    try {
      const raw = fs.readFileSync(target, 'utf8');
      created = false;
      mode = fs.statSync(target).mode & 0o777;
      if (raw.trim()) {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'invalid-file';
        obj = parsed as Record<string, unknown>;
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') return err instanceof SyntaxError ? 'invalid-file' : 'error';
    }
    if (Object.prototype.hasOwnProperty.call(obj, 'cleanupPeriodDays')) return 'kept';
    obj.cleanupPeriodDays = days;
    // Write beside the file and rename over it: a crash never leaves half a settings file, and a
    // symlinked settings.json (an added account's dir) keeps pointing at the primary's file.
    const tmp = `${target}.dispatch-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode });
    fs.renameSync(tmp, target);
    return created ? 'created' : 'added';
  } catch {
    return 'error';
  }
}
