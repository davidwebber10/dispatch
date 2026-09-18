import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { HarnessEvent, HarnessIdentity, TurnResult } from './events.js';
import { getProvider } from '../providers/registry.js';

interface Stream { generation: string; sequence: number; turnId?: string; nativeTurnId?: string; sessionId?: string; active: boolean }
/** One native-manager boundary shared by the CLI protocol adapters. */
export function subscribeHarnessEvents(manager: EventEmitter, providerFor: (id: string) => string | undefined,
  consume: (event: HarnessEvent) => void, transport: 'structured' | 'runner' = 'structured', now = () => new Date().toISOString()): () => void {
  const streams = new Map<string, Stream>();
  const listeners: [string, (...args: any[]) => void][] = [];
  const on = (name: string, fn: (...args: any[]) => void) => {
    const guarded = (...args: any[]) => {
      try { fn(...args); }
      catch (error) {
        try { emit(args[0], { type: 'capture.failed', reason: error instanceof Error ? error.message : 'Adapter failure' }); }
        catch { console.warn('Harness adapter failed:', name); }
      }
    };
    manager.on(name, guarded); listeners.push([name, guarded]);
  };
  type Payload = HarnessEvent extends infer E ? E extends HarnessIdentity ? Omit<E, keyof HarnessIdentity> : never : never;
  const emit = (id: string, payload: Payload, extra: Partial<HarnessIdentity> = {}) => {
    const provider = providerFor(id); if (!provider) return;
    let s = streams.get(id);
    if (!s) {
      s = { generation: randomUUID(), sequence: 0, active: false }; streams.set(id, s);
      consume({ type: 'process.started', terminalId: id, provider, generation: s.generation, sequence: 0,
        eventId: `${s.generation}:0`, observedAt: now(), transport });
    }
    // Update producer state before consuming: completion effects may synchronously
    // submit another turn, which must receive a fresh identity.
    if (payload.type === 'turn.started') {
      s.active = true; s.turnId = extra.turnId; s.nativeTurnId = extra.nativeTurnId;
    }
    if (payload.type === 'turn.completed' || payload.type === 'turn.failed') s.active = false;
    if (payload.type === 'session.identified') s.sessionId = extra.sessionId;
    if (payload.type === 'process.exited') streams.delete(id);
    s.sequence++;
    consume({ ...payload, terminalId: id, provider, generation: s.generation, sequence: s.sequence,
      eventId: `${s.generation}:${s.sequence}`, observedAt: now(), transport,
      sessionId: s.sessionId, turnId: s.turnId, nativeTurnId: s.nativeTurnId, ...extra } as HarnessEvent);
    return s;
  };
  on('session', (id: string, sessionId: string) => {
    emit(id, { type: 'session.identified' }, { sessionId });
  });
  on('busy', (id: string, detail?: { turnId?: string }) => {
    const old = streams.get(id);
    const turnId = old?.active ? old.turnId : randomUUID();
    emit(id, { type: 'turn.started' }, { turnId, nativeTurnId: detail?.turnId ?? (old?.active ? old.nativeTurnId : undefined) });
  });
  on('event', (id: string, frame: any) => {
    if (!frame || (!frame.message?.usage && !frame.message?.content && frame.type !== 'result')) return;
    const type = providerFor(id); if (!type) return;
    const provider = getProvider(type);
    const s = streams.get(id);
    const measurements = provider.telemetry.normalizeUsage(frame);
    const cost = provider.telemetry.reportedCost(frame);
    const total = provider.telemetry.costCounter(frame);
    if (cost !== null || total !== null) measurements.push({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0,
      model: '', source: transport, kind: 'cost', reportedCostUsd: cost, eventId: `turn:${s?.turnId}:cost`,
      ...(total !== null ? { counter: { key: 'reported-cost', unit: 'usd' as const, final: true, totals: { input: total, output: 0, cacheRead: 0, cacheCreate: 0 } } } : {}) });
    if (measurements.length) emit(id, { type: 'usage.observed', measurements: measurements.map(m => ({ ...m, source: transport })) }, {
      sessionId: frame?.session_id ?? frame?.telemetry?.sessionId ?? s?.sessionId,
      nativeTurnId: frame?.telemetry?.turnId ?? s?.nativeTurnId,
    });
  });
  on('permission', (id: string, pending: any) => emit(id, { type: 'permission.requested', toolName: pending?.toolName, questions: pending?.questions }));
  on('resolved', (id: string) => emit(id, { type: 'permission.resolved' }));
  const complete = (id: string, outcome: 'idle' | 'needs_help' | 'scheduled', detail: TurnResult) => {
    emit(id, { type: 'turn.completed', outcome, detail });
  };
  on('idle', (id: string, detail?: TurnResult) => complete(id, 'idle', detail ?? {}));
  on('needs-help', (id: string, detail?: TurnResult) => complete(id, 'needs_help', detail ?? {}));
  on('scheduled', (id: string, activity?: string) => complete(id, 'scheduled', { activity }));
  on('failed', (id: string) => emit(id, { type: 'turn.failed' }));
  on('exit', (id: string, exitCode: number) => { emit(id, { type: 'process.exited', exitCode }); });
  return () => { for (const [name, fn] of listeners) manager.off(name, fn); streams.clear(); };
}
