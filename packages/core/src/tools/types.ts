export interface ToolBinaryAsset { url: string; sha256?: string; archive?: 'tar.gz' | 'zip' | 'none'; binPath?: string; }
/** How to ask a CLI whether it can sign in: exactly one of `args` (run the entry's first bin
 *  with them) or `shell` (run via `/bin/sh -c`). Exit 0 means authenticated. Output is always
 *  discarded — some of these commands print tokens or account ids. `unknownExitCodes` are
 *  exits that mean "could not tell" (e.g. 124: the check's own time limit hit) rather than
 *  "not signed in". */
export interface ToolAuthCheck { args?: string[]; shell?: string; timeoutMs?: number; unknownExitCodes?: number[]; }
/** An authCheck run: 'ok' = exit 0, 'failed' = a non-zero exit, 'unknown' = it never gave an
 *  answer (timeout, spawn error, killed by a signal). */
export type AuthCheckOutcome = 'ok' | 'failed' | 'unknown';
export interface ToolEntry {
  name: string;
  description: string;
  kind: 'binary' | 'npm' | 'script';
  binary?: Record<string, ToolBinaryAsset>; // platform key -> asset
  npm?: { package: string; version?: string };
  script?: { install: string };
  bins: string[];
  authEnv?: string[];
  envAlias?: Record<string, string>; // CLI-expected var -> source env var name
  authCheck?: ToolAuthCheck;
  docs?: string;
  /** OS families this recipe supports, e.g. ['darwin'] — same vocabulary as the OS prefix of
   *  toolPlatformKey() ('darwin' | 'linux'). Omitted means "all platforms". Recipes that shell
   *  out to an OS-specific tool (e.g. macOS's pkgutil) but haven't been given a variant for
   *  other platforms yet should be gated here rather than failing at install time. */
  platforms?: string[];
}
/** 'needed' = sign-in is missing or failed; 'unknown' = it has a check that gave no answer
 *  (or has not run yet) and no auth env to go by. */
export type ToolAuthState = 'ok' | 'needed' | 'unknown';
export interface ToolStatus {
  name: string;
  description: string;
  kind: ToolEntry['kind'];
  installed: boolean;
  version?: string;
  /** authState === 'ok'; kept for older clients. */
  authed: boolean;
  authState: ToolAuthState;
  docs?: string;
}
