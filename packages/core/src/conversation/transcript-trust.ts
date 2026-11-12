// packages/core/src/conversation/transcript-trust.ts
// A thread's transcript is in the agent's home, so the agent can replace it with a link. With
// privilege separation the daemon runs as root, and a read that follows that link would give a
// thread key the content (or the line count) of a file only root can read. So, before the daemon
// reads a transcript with its own rights:
//   - the path is a plain file, not a link (lstat), and its real path is inside a transcript root
//     (`~/.claude/projects`, `~/.codex/sessions`, `~/.codex/archived_sessions`);
//   - the file is opened with O_NOFOLLOW, and the OPEN file is a plain file of the agent user (a check
//     on the descriptor, so a folder renamed between the two checks does not open another file).
// On a local install (no privilege separation) the owner is not checked: the daemon is the user.
import fs from 'fs';
import path from 'path';
import { privsep } from '../privsep/config.js';

/** Flags for every transcript open of the daemon: read only, never through a final link. */
export const TRANSCRIPT_OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);

const agentUid = (): number | null => privsep()?.agentUid ?? null;

const inside = (child: string, parent: string): boolean => child.startsWith(parent + path.sep);

/** True when the daemon may read `file` as a transcript (see the top of this file). */
export function transcriptPathTrusted(file: string, roots: string[], uid: number | null = agentUid()): boolean {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return false;
    if (uid !== null && st.uid !== uid) return false;
    const real = fs.realpathSync(file);
    return roots.some((r) => {
      try { return inside(real, fs.realpathSync(r)); } catch { return false; }
    });
  } catch {
    return false;
  }
}

/** True when an OPEN transcript (its fstat) is a plain file of the agent user. */
export function openedTranscriptTrusted(st: fs.Stats, uid: number | null = agentUid()): boolean {
  return st.isFile() && (uid === null || st.uid === uid);
}
