// packages/core/src/limits/codex-refresh.ts
// Codex writes its limits into the session file. This reads the newest figures for one thread, at
// most every 30 s per thread. The Details route and the usage gauge's tick share one instance (#127).
import { locateCodexTranscript } from '../analytics/codex-locate.js';
import { readCodexRateLimits } from '../analytics/codex-frames.js';
import { accountIdFor, codexLoginChangedAt } from './account.js';
import { parseCodexRateLimits, type LimitSnapshots } from './snapshot.js';

export const CODEX_REFRESH_MS = 30_000;

export interface CodexRefreshOpts {
  now?: () => number;
  accountFor?: (provider: string) => string;
  codexLoginChangedAt?: () => number;
  codexRoots?: { sessions?: string; archived?: string };
}

export type CodexRefresh = (terminalId: string, externalId: string | null) => void;

export function createCodexRefresh(snapshots: LimitSnapshots, opts: CodexRefreshOpts = {}): CodexRefresh {
  const now = opts.now ?? Date.now;
  const accountFor = opts.accountFor ?? accountIdFor;
  const loginChangedAt = opts.codexLoginChangedAt ?? codexLoginChangedAt;
  const lastRead = new Map<string, number>();
  return (terminalId, externalId) => {
    const t = now();
    if (!externalId || t - (lastRead.get(terminalId) ?? 0) < CODEX_REFRESH_MS) return;
    lastRead.set(terminalId, t);
    const file = locateCodexTranscript(externalId, opts.codexRoots);
    const found = file ? readCodexRateLimits(file) : null;
    if (!found) return;
    // Figures written before the login file last changed may belong to another account: do not claim them.
    if (!found.at || found.at < loginChangedAt()) return;
    const { windows, plan } = parseCodexRateLimits(found.rateLimits);
    snapshots.record('codex', accountFor('codex'), windows, found.at, plan, true);
  };
}
