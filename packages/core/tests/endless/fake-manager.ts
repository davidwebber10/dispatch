import { EventEmitter } from 'node:events';
import type { IStructuredManager, StructuredSpawnOpts, ContentBlock, PermissionDecision } from '../../src/structured/manager.js';

/** Records spawns and stdin writes; tests drive the CLI side with emitEvent / emitExit. */
export class FakeManager extends EventEmitter {
  spawned: { id: string; opts: StructuredSpawnOpts }[] = [];
  sent: { id: string; content: string | ContentBlock[] }[] = [];
  killed: string[] = [];
  answers: { id: string; requestId: string; decision: PermissionDecision }[] = [];
  private alive = new Set<string>();
  spawn(id: string, opts: StructuredSpawnOpts): number { this.spawned.push({ id, opts }); this.alive.add(id); return 1; }
  sendMessage(id: string, content: string | ContentBlock[]): void {
    this.sent.push({ id, content });
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    this.emit('event', id, { type: 'user', message: { role: 'user', content: blocks } });
  }
  kill(id: string): void { this.killed.push(id); this.alive.delete(id); }
  killAll(): void { for (const id of [...this.alive]) this.kill(id); }
  isAlive(id: string): boolean { return this.alive.has(id); }
  answerPermission(id: string, requestId: string, decision: PermissionDecision): boolean { this.answers.push({ id, requestId, decision }); return true; }
  setDefaultEnv(): void {}
  lastId(): string { return this.spawned[this.spawned.length - 1].id; }
  emitEvent(ev: unknown): void { this.emit('event', this.lastId(), ev); }
  emitExit(code: number): void { const id = this.lastId(); this.alive.delete(id); this.emit('exit', id, code); }
  asManager(): IStructuredManager { return this as unknown as IStructuredManager; }
}

export const texts = (content: string | ContentBlock[]): string[] =>
  typeof content === 'string' ? [content] : content.map((b) => (b.type === 'text' ? b.text : '[image]'));
