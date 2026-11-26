import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

let cached: string | null = null;

/** The version this running daemon was built from (packages/core/package.json). */
export function getRunningVersion(): string {
  if (cached) return cached;
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    cached = String(pkg.version || '0.0.0');
  } catch {
    cached = '0.0.0';
  }
  return cached;
}

/** Test seam: clear the cached version so getRunningVersion() re-reads the file. */
export function _resetRunningVersionCache(): void {
  cached = null;
}

/**
 * A box build of a release: `<base>-box.<n>` (for example `4.14.1-box.2`). It is built from the git tag
 * `box-<base>-<n>` on main, without a desktop release (docs/hosted.md, "Box releases"). `<base>` is the
 * release in package.json at that commit; `<n>` counts box builds of that base, from 1.
 */
export const BOX_VERSION_SHAPE = /^(\d+\.\d+\.\d+)-box\.([1-9]\d*)$/;

/**
 * The image version that the hosted image build wrote into the image (`DISPATCH_IMAGE_VERSION`), when
 * it names THIS code: a box build of the running release, or the release itself. Anything else (no
 * value, a branch build, a value for another release) is null, and the caller reports the release.
 */
export function getImageVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = (env.DISPATCH_IMAGE_VERSION ?? '').trim();
  if (!v) return null;
  const running = getRunningVersion();
  if (v === running) return v;
  const m = BOX_VERSION_SHAPE.exec(v);
  return m && m[1] === running ? v : null;
}

/**
 * The version this daemon REPORTS: to the platform (heartbeat, box log) and on a hosted box's update
 * page. A box build reports `<base>-box.<n>`, so the platform can tell two box builds of one release
 * apart. The release code paths (the desktop updater, release notes, plugins, telemetry) keep
 * getRunningVersion(): a box build is never a desktop release.
 */
export function getReportedVersion(env: NodeJS.ProcessEnv = process.env): string {
  return getImageVersion(env) ?? getRunningVersion();
}

type VersionKey = [number, number, number, number];

function parseVersion(v: string): VersionKey {
  const bare = v.replace(/^v/i, '');
  const box = BOX_VERSION_SHAPE.exec(bare);
  const base = box ? box[1] : bare;
  const parts = base.split('.').map((n) => parseInt(n, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, box ? Number(box[2]) : 0];
}

/**
 * Order two versions: negative when `a` is older, positive when newer, 0 when equal. A box build sorts
 * after its own release and before the next one: 4.14.1 < 4.14.1-box.1 < 4.14.1-box.2 < 4.14.2.
 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** True when `candidate` (e.g. a release tag) is a strictly newer version than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}
