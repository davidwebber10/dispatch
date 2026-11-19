import type { MemoryProvider } from './types.js';

/** OpenCode has no memory of its own (instructions only): its threads use Dispatch memory. */
export function opencodeProvider(): MemoryProvider {
  return {
    id: 'opencode',
    label: 'OpenCode',
    capabilities: { scopes: [], write: 'none', delete: false, loadedByHarness: false },
    status: () => ({ native: false, state: 'not-supported', location: null }),
    list: () => [],
    read: () => null,
  };
}
