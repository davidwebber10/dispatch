/**
 * A signed-out or expired login, told apart from every other failure (2026-11-07), so a Pretty
 * thread can show "<account> is signed out" with a way to sign in instead of the raw error.
 *
 * Applied ONLY to a turn's error text (an error `result`, a spawn error), never to tool output,
 * so a word like "login" in a file the agent read cannot trip it. The strings come from the CLIs:
 *   Claude Code — "Invalid API key · Please run /login", "OAuth token has expired",
 *                 "Failed to authenticate: OAuth session expired and could not be refreshed",
 *                 "API Error: 401 … authentication_error".
 *   Codex       — "unexpected status 401 Unauthorized", "access token could not be refreshed",
 *                 "Not logged in".
 *   Grok / ACP  — "Authentication required" (the ACP auth_required error), OpenCode's
 *                 "ProviderAuthError" / "No API key found".
 */
export type AuthProvider = 'claude' | 'codex' | 'grok' | 'opencode';

const RULES: Array<[RegExp, string]> = [
  [/token (?:has )?expired|session expired|could not be refreshed|refresh[_ ]token[_ ](?:expired|reused|invalidated|was already used)/i, 'The login expired'],
  [/invalid api key/i, 'The login is not valid'],
  [/not logged in|not signed in|authentication required|auth_required|login required|no api key found|providerautherror|no credentials/i, 'Not signed in'],
  [/authentication_error|failed to authenticate|\b401\b[^\n]{0,40}unauthori[sz]ed|\bunauthori[sz]ed\b|status 401|api error: 401|token has been invalidated/i, 'The login was refused'],
  [/please run \/login|run `?(?:claude|codex|grok|opencode)(?: auth)? login/i, 'Not signed in'],
];

/** The short reason when `text` reports a signed-out or expired login, else null. */
export function detectAuthFailure(text: string): string | null {
  if (!text) return null;
  for (const [re, reason] of RULES) if (re.test(text)) return reason;
  return null;
}

export interface AuthRequiredFrame {
  type: 'system';
  subtype: 'auth_required';
  provider: AuthProvider;
  /** The account the thread runs on (config.accountId, else the default); absent for Grok/OpenCode. */
  accountId?: string;
  reason: string;
  /** The CLI's own words, for the card's "details". */
  detail: string;
}

/** The text an error frame carries: a result's `result` and `errors[]`, a spawn error's `message`. */
function errorText(e: any): string | null {
  if (!e || typeof e !== 'object') return null;
  if (e.type === 'result' && e.is_error === true) {
    const parts: string[] = [];
    if (typeof e.result === 'string') parts.push(e.result);
    if (Array.isArray(e.errors)) for (const x of e.errors) if (typeof x === 'string') parts.push(x);
    return parts.join('\n');
  }
  if (e.type === 'system' && e.subtype === 'spawn_error' && typeof e.message === 'string') return e.message;
  return null;
}

/**
 * The typed `system/auth_required` chat event for an error frame that reports a signed-out login,
 * or null. Each structured manager pushes it into its ring right after the error frame.
 */
export function authRequiredFrame(event: unknown, provider: AuthProvider, accountId: string | undefined): AuthRequiredFrame | null {
  const text = errorText(event);
  if (!text) return null;
  const reason = detectAuthFailure(text);
  if (!reason) return null;
  return { type: 'system', subtype: 'auth_required', provider, ...(accountId ? { accountId } : {}), reason, detail: text.slice(0, 500) };
}
