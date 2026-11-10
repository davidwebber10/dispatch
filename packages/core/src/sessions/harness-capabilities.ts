/**
 * What a thread type can do, for the code of the session services (W3-B). It replaces a comparison
 * of the type name where the meaning is a capability. `providers/capabilities.ts` has the table
 * that the UI reads (`harnessCapabilities()`); this one is for the daemon's own decisions.
 */
export interface ThreadHarnessCapabilities {
  /**
   * The thread's history comes from its REST transcript, not from a replay of the ring. Codex only:
   * a Codex item has no uuid, so a REST page that overlaps the replay cannot be de-duplicated.
   */
  restHistory: boolean;
  /** A durable transcript that REST can page. Without one, history cut from a replay is gone. */
  restPageable: boolean;
  /** Full-history text search of the transcript. */
  transcriptSearch: boolean;
}

const NONE: ThreadHarnessCapabilities = { restHistory: false, restPageable: false, transcriptSearch: false };

const TABLE: Record<string, ThreadHarnessCapabilities> = {
  'claude-code': { restHistory: false, restPageable: true, transcriptSearch: true },
  codex: { restHistory: true, restPageable: true, transcriptSearch: false },
};

/** The capabilities of a thread type. An unknown type, a shell tab and no type at all have none. */
export function threadHarnessCapabilities(type: string | null | undefined): ThreadHarnessCapabilities {
  return (type && TABLE[type]) || NONE;
}
