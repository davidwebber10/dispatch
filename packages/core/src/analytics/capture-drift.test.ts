import { describe, it, expect } from 'vitest';
import { AGENT_TYPES } from '../providers/agent-types.js';
import { PTY_CAPTURE_STRATEGY } from './pty-capture.js';

/**
 * The equivalent of tests/providers/agent-types.test.ts, one layer down: that
 * suite guards AGENT_TYPES against the provider registry, and this one guards
 * the capture dispatch map against AGENT_TYPES itself. Adding a fourth agent
 * type without saying how (or whether) it is captured used to mean the harness
 * spawned, ran, and silently recorded no usage — the same class of bug
 * agent-types.ts's own doc comment describes for the sidebar, peer tools, and
 * MCP servers. Now it fails here.
 *
 * `null` counts as a declared strategy — Grok is legitimately uncaptured on the
 * PTY path (no transcript, no session id, no lifecycle event). Only a MISSING
 * key fails these tests: `hasOwnProperty` distinguishes "declared not-captured"
 * from "never declared at all", which a plain `Record[type]` truthiness check
 * would not.
 *
 * (HISTORY_IMPORT_STRATEGY used to be guarded here too; the history importer
 * was removed by decision — analytics is live recording only.)
 */
describe('every agent type has a declared PTY capture strategy', () => {
  it('pty-capture.ts', () => {
    for (const t of AGENT_TYPES) {
      expect(Object.prototype.hasOwnProperty.call(PTY_CAPTURE_STRATEGY, t), `"${t}" has no PTY_CAPTURE_STRATEGY entry`).toBe(true);
    }
  });

  it('has no stray entry for a type that is not an agent type', () => {
    expect(Object.keys(PTY_CAPTURE_STRATEGY).sort()).toEqual([...AGENT_TYPES].sort());
  });
});
