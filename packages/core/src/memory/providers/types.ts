/**
 * A memory provider (spec 2026-11-17-memory-design.md, 4.8): one place where memory lives. Dispatch's
 * own store is one; each harness's own memory folder is another. Dispatch MIRRORS a harness provider
 * (it does not convert its entries): the harness file is the truth, and Dispatch keeps a copy for
 * search and for the screen. Search is not part of the interface: Dispatch indexes every provider's
 * entries in one full-text index.
 */

export type ProviderId = 'dispatch' | 'claude' | 'codex' | 'grok' | 'opencode';

/** The scope a provider is asked about: You, or one project with its working folder. */
export type ProviderScope = { scope: 'you' } | { scope: `project:${string}`; workingDir: string };

export interface ProviderStatus {
  /** The harness has a memory of its own. */
  native: boolean;
  /** The harness's own switch, as Dispatch reads it. Dispatch never changes it in v1. */
  state: 'on' | 'off' | 'not-supported' | 'not-installed';
  /** The folder or file, for the screen. */
  location: string | null;
}

export interface ProviderCapabilities {
  scopes: ('you' | 'project')[];
  /** What a write from Dispatch's screen does: nothing, a memory entry, or a line of the harness's instructions. */
  write: 'none' | 'memory' | 'instructions';
  delete: boolean;
  /** The harness loads these entries into its own threads by itself. */
  loadedByHarness: boolean;
}

export interface ProviderEntry {
  /** The path inside the provider's root (the entry's id for this provider and scope). */
  rel: string;
  title: string;
  description: string;
  text: string;
  sha: string;
  mtimeMs: number;
  /** Dispatch may write it back (write-through). */
  writable: boolean;
}

export interface EntryWrite { rel?: string; title: string; description?: string; text: string }
export type WriteResult =
  | { ok: true; rel: string }
  | { ok: false; conflict: true; current: ProviderEntry | null }
  | { ok: false; conflict: false; error: string };

export interface MemoryProvider {
  id: ProviderId;
  label: string;
  capabilities: ProviderCapabilities;
  status(scope: ProviderScope | null): ProviderStatus;
  list(scope: ProviderScope): ProviderEntry[];
  read(scope: ProviderScope, rel: string): ProviderEntry | null;
  /** Write-through. `expectedSha` null: a new entry. The file always wins: a changed file is a conflict, never overwritten. */
  write?(scope: ProviderScope, entry: EntryWrite, expectedSha: string | null): WriteResult;
  remove?(scope: ProviderScope, rel: string, expectedSha: string): WriteResult;
}

/** `name: value` lines of a leading `---` block (one level; `metadata.type` as `type`). */
export function frontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const text = raw.replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv && kv[2].trim()) fields[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { fields, body: text.slice(m[0].length) };
}

/** A file name from a title: a-z, 0-9 and -, at most 60 characters. */
export const fileSlug = (title: string): string =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'memory';

/** One line: no line breaks, at most `max` characters. */
export const oneLine = (s: string, max = 160): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
