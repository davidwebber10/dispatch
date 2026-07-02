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

function parseSemver(v: string): [number, number, number] {
  const parts = v.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** True when `candidate` (e.g. a release tag) is a strictly newer semver than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const [cMaj, cMin, cPat] = parseSemver(candidate);
  const [rMaj, rMin, rPat] = parseSemver(current);
  if (cMaj !== rMaj) return cMaj > rMaj;
  if (cMin !== rMin) return cMin > rMin;
  return cPat > rPat;
}
