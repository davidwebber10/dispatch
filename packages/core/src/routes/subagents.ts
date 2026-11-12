import type { Router } from 'express';
import { needs, keyRoute, policyRouter } from '../auth/route-policy.js';
import { allowRule, readRule } from '../auth/key-rules.js';
import { redactKeysDeep } from '../auth/redact-keys.js';
import type { MessageJournal } from '../journal/journal.js';
import { publicItem } from '../journal/replay.js';
import type { IStructuredManager } from '../structured/manager.js';
import { isSubagentFrame, RUNNING_STATES, type SubagentInfo } from '../structured/shared/subagents.js';
import { readSidechainEvents } from '../sessions/cc-sessions.js';

/** What the subagent routes need of a thread. */
export interface SubagentRouteDeps {
  journal?: MessageJournal;
  /** The thread's row, or null when the id is no thread. */
  thread: (terminalId: string) => { type: string; externalId: string | null; workingDir: string | null } | null;
  /** The live structured manager of the thread, or undefined. */
  manager: (terminalId: string) => IStructuredManager | undefined;
}

/**
 * The subagents of a thread (capability `subagents-v1`, docs/headless-api.md):
 *
 *   GET  /api/terminals/:terminalId/agents                     the list, with states
 *   GET  /api/terminals/:terminalId/agents/:agentId/journal    one subagent's items, paged like the journal
 *   POST /api/terminals/:terminalId/agents/:agentId/stop       stop one subagent
 *   POST /api/terminals/:terminalId/agents/stop-all            stop every subagent (and the main turn)
 *
 * The reads have the key rules of the main journal route; the stops are owner only, like the
 * thread's own interrupt.
 */
export function createSubagentsRouter(deps: SubagentRouteDeps): Router {
  const router = policyRouter();
  const readRules = { thread: readRule, roleRun: readRule, chat: allowRule, summarizer: allowRule, plugin: needs('read:threads') };

  /** The list: the journal's lifecycle frames (they survive a restart), then the live session's, newest state wins. */
  const listOf = (terminalId: string): { agents: SubagentInfo[]; live: boolean } => {
    const byId = new Map<string, SubagentInfo>();
    for (const f of deps.journal?.subagentFrames(terminalId) ?? []) {
      if (!isSubagentFrame(f)) continue;
      const { type: _t, subtype: _s, seq: _q, ...info } = f as Record<string, unknown>;
      byId.set(f.id, info as unknown as SubagentInfo);
    }
    const live = deps.manager(terminalId)?.listSubagents?.(terminalId) ?? null;
    for (const a of live ?? []) byId.set(a.id, a);
    // A subagent the journal shows running with no live session to run it: the session ended under it.
    const agents = [...byId.values()].map((a) => (live === null && RUNNING_STATES.has(a.state) ? { ...a, state: 'stopped' as const } : a));
    return { agents, live: live !== null };
  };

  router.get('/terminals/:terminalId/agents', keyRoute(readRules), (req, res) => {
    const id = req.params.terminalId;
    try {
      if (!deps.thread(id)) return void res.status(404).json({ error: 'Thread not found' });
      const { agents, live } = listOf(id);
      res.json(redactKeysDeep({ agents, live, running: agents.filter((a) => RUNNING_STATES.has(a.state)).length }));
    } catch (err) {
      console.error(`[subagents] list of ${id} failed:`, err);
      res.status(500).json({ error: 'Could not read the subagents' });
    }
  });

  /**
   * One subagent's items: `{ items, firstSeq, lastSeq, hasMore }` like the journal page (its frames
   * and its lifecycle frames, by `before=`/`after=`/`limit=`). When the journal has no frame of it and
   * no cursor is given, `history` holds its steps from the harness instead (Claude: its sidechain
   * transcript; Codex: `thread/read` of its sub-thread), as events tagged with its id.
   */
  router.get('/terminals/:terminalId/agents/:agentId/journal', keyRoute(readRules), async (req, res) => {
    const { terminalId, agentId } = req.params;
    const read = (name: string): number | undefined | null => {
      const raw = req.query[name];
      if (raw === undefined) return undefined;
      return typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : null;
    };
    const before = read('before');
    const after = read('after');
    const limit = read('limit');
    if (before === null || after === null || limit === null || limit === 0) return void res.status(400).json({ error: 'before, after and limit must be whole numbers (limit at least 1)' });
    if (before !== undefined && after !== undefined) return void res.status(400).json({ error: 'Give before or after, not both' });
    try {
      const thread = deps.thread(terminalId);
      if (!thread) return void res.status(404).json({ error: 'Thread not found' });
      const agent = listOf(terminalId).agents.find((a) => a.id === agentId);
      if (!agent) return void res.status(404).json({ error: 'Subagent not found' });
      const page = deps.journal?.pageAgent(terminalId, agentId, { beforeSeq: before, afterSeq: after, limit })
        ?? { items: [], firstSeq: 0, lastSeq: 0, hasMore: false };
      const body: Record<string, unknown> = { agent, items: page.items.map(publicItem), firstSeq: page.firstSeq, lastSeq: page.lastSeq, hasMore: page.hasMore };
      const hasFrames = page.items.some((i) => !isSubagentFrame(i.payload));
      if (!hasFrames && before === undefined && after === undefined) {
        let history: unknown[] | null = null;
        if (thread.type === 'claude-code' && thread.externalId && thread.workingDir) history = readSidechainEvents(thread.workingDir, thread.externalId, agentId, agent.nativeId);
        else history = (await deps.manager(terminalId)?.readSubagentHistory?.(terminalId, agentId)) ?? null;
        if (history?.length) body.history = history;
      }
      res.json(redactKeysDeep(body));
    } catch (err) {
      console.error(`[subagents] journal of ${terminalId}/${agentId} failed:`, err);
      res.status(500).json({ error: 'Could not read the subagent' });
    }
  });

  router.post('/terminals/:terminalId/agents/stop-all', async (req, res) => {
    const id = req.params.terminalId;
    try {
      if (!deps.thread(id)) return void res.status(404).json({ error: 'Thread not found' });
      const m = deps.manager(id);
      if (!m?.isAlive(id) || !m.stopAllSubagents) return void res.status(409).json({ error: 'No live structured session' });
      res.json(await m.stopAllSubagents(id));
    } catch (err) {
      console.error(`[subagents] stop-all of ${id} failed:`, err);
      res.status(500).json({ error: 'Could not stop the subagents' });
    }
  });

  router.post('/terminals/:terminalId/agents/:agentId/stop', async (req, res) => {
    const { terminalId, agentId } = req.params;
    try {
      if (!deps.thread(terminalId)) return void res.status(404).json({ error: 'Thread not found' });
      const m = deps.manager(terminalId);
      if (!m?.isAlive(terminalId) || !m.stopSubagent) return void res.status(409).json({ error: 'No live structured session' });
      const result = await m.stopSubagent(terminalId, agentId);
      switch (result) {
        case 'stopped': return void res.json({ result });
        case 'not-found': return void res.status(404).json({ error: 'Subagent not found', result });
        case 'not-running': return void res.status(409).json({ error: 'The subagent is not running', result });
        default: return void res.status(501).json({ error: 'This subagent cannot be stopped on its own. Stop the reply instead.', result });
      }
    } catch (err) {
      console.error(`[subagents] stop of ${terminalId}/${agentId} failed:`, err);
      res.status(500).json({ error: 'Could not stop the subagent' });
    }
  });

  return router;
}
