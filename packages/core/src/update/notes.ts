import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isNewerVersion } from './version.js';

/** One release's human-readable notes, as shown in the update prompt. */
export interface ReleaseNote {
  /** The git tag, e.g. `v2.11.0`. */
  version: string;
  url: string;
  publishedAt: string;
  /** Markdown — the GitHub Release body, which `dispatch release` fills from docs/releases/. */
  notes: string;
}

/** Shape of the entries GitHub's `GET /repos/:repo/releases` returns. */
export interface GitHubRelease {
  tag_name: string;
  html_url: string;
  published_at: string;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

/**
 * How many releases of notes we keep. An install that is 20 versions behind does not
 * need all 20 in the prompt, and the whole list lives in one app_state row.
 */
export const MAX_NOTES = 10;
/** Per-release body cap, for the same reason. */
export const MAX_NOTE_CHARS = 8000;

/** Only a plain semver may become a filename — never a caller-supplied path fragment. */
const SEMVER_ONLY = /^v?\d+\.\d+\.\d+$/;

/**
 * The repo root, resolved from this module rather than `process.cwd()` — the daemon is
 * started from an arbitrary directory. Four levels up reaches the root from both
 * `packages/core/src/update/` (dev) and `packages/core/dist/update/` (built), the same
 * trick `getRunningVersion()` uses.
 */
function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
}

/**
 * The hand-written note for a version, from `docs/releases/vX.Y.Z.md`.
 *
 * This is the "what am I running right now" half of the feature. The notes for a
 * *pending* update cannot come from disk — this checkout is still on the old version —
 * so those come from GitHub instead (see `collectPendingNotes`).
 */
export function readLocalReleaseNote(version: string, root: string = repoRoot()): string | null {
  if (!SEMVER_ONLY.test(version)) return null;
  const tag = version.startsWith('v') ? version : `v${version}`;
  try {
    const body = fs.readFileSync(path.join(root, 'docs', 'releases', `${tag}.md`), 'utf-8').trim();
    return body === '' ? null : body;
  } catch {
    return null;
  }
}

function truncate(body: string): string {
  if (body.length <= MAX_NOTE_CHARS) return body;
  return `${body.slice(0, MAX_NOTE_CHARS)}\n\n_(truncated)_`;
}

/**
 * Every release newer than `currentVersion`, newest first — so an install that skipped
 * two versions sees all three sets of notes, not only the target's.
 */
export function collectPendingNotes(releases: GitHubRelease[], currentVersion: string): ReleaseNote[] {
  return releases
    .filter((r) => r && !r.draft && !r.prerelease && !!r.tag_name)
    .filter((r) => isNewerVersion(r.tag_name, currentVersion))
    .sort((a, b) => (isNewerVersion(a.tag_name, b.tag_name) ? -1 : 1))
    .slice(0, MAX_NOTES)
    .map((r) => ({
      version: r.tag_name,
      url: r.html_url ?? '',
      publishedAt: r.published_at ?? '',
      notes: truncate(String(r.body ?? '')),
    }));
}

/**
 * Read the stored list back, re-filtered against the running version. The filter runs
 * again on purpose: `/api/state/update` treats stored update data as a cache, never as a
 * trusted flag, so a daemon that has already updated cannot serve notes for itself.
 */
export function parseStoredNotes(raw: string | null, currentVersion: string): ReleaseNote[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return (parsed as ReleaseNote[]).filter(
    (n) => n && typeof n.version === 'string' && typeof n.notes === 'string' && isNewerVersion(n.version, currentVersion),
  );
}
