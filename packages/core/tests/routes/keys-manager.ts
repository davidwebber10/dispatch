import type { ContentBlock, PendingPermission, PermissionDecision, StructuredSpawnOpts } from '../../src/structured/manager.js';
import { FakeManager } from '../endless/fake-manager.js';

/** A manager that is alive for every thread, records what it receives and holds settable pending requests. */
export class KeysManager extends FakeManager {
  pending = new Map<string, PendingPermission>();
  repliesToQuestions = true;
  override isAlive(): boolean { return true; }
  override spawn(id: string, opts: StructuredSpawnOpts): number { this.spawned.push({ id, opts }); return 1; }
  getPending(id: string): PendingPermission | null { return this.pending.get(id) ?? null; }
  setEscalate(): boolean { return true; }
  getEvents(): unknown[] { return []; }
  getEventsTail(): unknown[] { return []; }
  getSessionId(): string | undefined { return undefined; }
  override answerPermission(id: string, requestId: string, decision: PermissionDecision): boolean {
    this.answers.push({ id, requestId, decision });
    return true;
  }
  sentTo(id: string): (string | ContentBlock[])[] { return this.sent.filter((s) => s.id === id).map((s) => s.content); }
}
