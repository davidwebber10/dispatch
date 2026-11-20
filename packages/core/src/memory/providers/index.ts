import type Database from 'better-sqlite3';
import * as store from '../../db/memory.js';
import { sha } from './safe-fs.js';
import { claudeProvider, type ClaudeDeps } from './claude.js';
import { codexProvider } from './codex.js';
import { grokProvider } from './grok.js';
import { opencodeProvider } from './opencode.js';
import type { MemoryProvider, ProviderEntry, ProviderId } from './types.js';

export type { MemoryProvider, ProviderEntry, ProviderId, ProviderScope, ProviderStatus, ProviderCapabilities, WriteResult } from './types.js';

/** The harness providers: Dispatch mirrors these. */
export const HARNESS_PROVIDERS: readonly ProviderId[] = ['claude', 'codex', 'grok', 'opencode'];
export const PROVIDER_IDS: readonly ProviderId[] = ['dispatch', ...HARNESS_PROVIDERS];

/** Dispatch's own store as a provider (its pages): always on, written through the Memory routes. */
export function dispatchProvider(db: Database.Database): MemoryProvider {
  const entryOf = (p: store.MemoryPage): ProviderEntry => ({ rel: p.slug, title: p.slug, description: p.description, text: p.body, sha: sha(p.body), mtimeMs: Date.parse(p.updatedAt) || 0, writable: true });
  return {
    id: 'dispatch',
    label: 'Dispatch',
    capabilities: { scopes: ['you', 'project'], write: 'memory', delete: true, loadedByHarness: false },
    status: () => ({ native: true, state: 'on', location: null }),
    list: (scope) => store.listPages(db, scope.scope).filter((p) => p.status === 'active').map((p) => entryOf(store.getPage(db, p.id)!)),
    read: (scope, rel) => { const p = store.getPageBySlug(db, scope.scope, rel); return p && p.status === 'active' ? entryOf(p) : null; },
  };
}

export interface ProvidersDeps extends ClaudeDeps { db: Database.Database }

export function buildProviders(deps: ProvidersDeps): Record<ProviderId, MemoryProvider> {
  return {
    dispatch: dispatchProvider(deps.db),
    claude: claudeProvider(deps),
    codex: codexProvider(deps),
    grok: grokProvider(deps),
    opencode: opencodeProvider(),
  };
}
