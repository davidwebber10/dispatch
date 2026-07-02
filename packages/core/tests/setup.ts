// Vitest setup — test process only, never production.
//
// On Windows, os.homedir() uses %USERPROFILE% and IGNORES $HOME. Many tests redirect
// the Claude/config home via `process.env.HOME = <tempdir>` (a posix idiom), so on the
// windows-latest CI those tests would read the *real* user home and fail (transcript
// lookups return null/undefined/[]). Patching os.homedir() here to honor $HOME first —
// matching posix behaviour — lets HOME-redirecting tests run correctly on Windows without
// each test having to also juggle USERPROFILE. Guarded to win32 so macOS/Linux are untouched.
import os from 'node:os';

if (process.platform === 'win32') {
  const original = os.homedir;
  os.homedir = () => process.env.HOME || process.env.USERPROFILE || original();
}
