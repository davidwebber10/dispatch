// Pure predicates + constants shared by the agency MCP tools and the HTTP routes
// that back them. Keep this a clean home for cross-cutting caps/limits — Task 6
// adds spawn-depth, pair-rate-limit, self-target, and archive guards alongside
// MAX_LIVE_WATCHES_PER_WATCHER (defined here first, in Task 3, since the watch
// routes need it before Task 6 lands).

/** Fan-out cap: a single watcher may hold at most this many live watches at once. */
export const MAX_LIVE_WATCHES_PER_WATCHER = 20;
