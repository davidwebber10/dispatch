import fs from 'fs';
import os from 'os';
import path from 'path';

export function codexSessionsRoot(): string { return path.join(os.homedir(), '.codex', 'sessions'); }
export function codexArchivedRoot(): string { return path.join(os.homedir(), '.codex', 'archived_sessions'); }

/**
 * Find a Codex transcript from the thread id Dispatch stores.
 *
 * The uuid in `rollout-<timestamp>-<uuid>.jsonl` IS the external_id — verified
 * against real rows. `session_index.jsonl` looks like the obvious answer and is not:
 * it went stale in June and carries no path field.
 *
 * The date directories are LOCAL time while `terminals.created_at` is UTC, so a
 * session started late in the evening sits in a bucket a naive UTC conversion would
 * never look in. Hence a walk over all buckets rather than a computed path. It reads
 * directory entries only — no file contents — which measured 0.00s over 441 files.
 */
export function locateCodexTranscript(
  externalId: string,
  roots: { sessions?: string; archived?: string } = {},
): string | undefined {
  if (!externalId) return undefined;
  const suffix = `-${externalId}.jsonl`;

  const inDir = (dir: string): string | undefined => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return undefined; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const hit = inDir(full);
        if (hit) return hit;
      } else if (e.name.startsWith('rollout-') && e.name.endsWith(suffix)) {
        return full;
      }
    }
    return undefined;
  };

  return inDir(roots.sessions ?? codexSessionsRoot()) ?? inDir(roots.archived ?? codexArchivedRoot());
}
