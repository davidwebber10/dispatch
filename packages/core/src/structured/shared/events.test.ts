// packages/core/src/structured/shared/events.test.ts
import { describe, it, expect, expectTypeOf } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRUCTURED_MANAGER_EVENT_NAMES, StructuredEmitter, type StructuredManagerEvents } from './events.js';
import type { IStructuredManager, PendingPermission } from '../manager.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('StructuredManagerEvents', () => {
  it('every event that a manager emits is in the map', () => {
    for (const file of ['manager.ts', 'codex-manager.ts', 'acp-manager.ts']) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      // The managers emit through the typed `fire`; a raw `this.emit(` would escape the map.
      expect(src, `${file} must not call this.emit directly`).not.toMatch(/this\.emit\(/);
      const fired = [...src.matchAll(/\bfire\(\s*'([a-z-]+)'/g)].map((m) => m[1]);
      expect(fired.length, `${file} fires events`).toBeGreaterThan(5);
      for (const name of fired) expect(STRUCTURED_MANAGER_EVENT_NAMES, `${file} fires '${name}'`).toContain(name);
    }
  });

  it('the name list and the map have the same keys', () => {
    const fromMap: Record<keyof StructuredManagerEvents, true> = {
      event: true, session: true, permission: true, 'permission-cleared': true, resolved: true, idle: true, 'needs-help': true,
      scheduled: true, busy: true, failed: true, exit: true, 'message-source': true, 'usage-limit': true, 'rate-limit': true,
      'auth-required': true, 'conversation-lost': true, 'process-restarted': true, 'settings-refused': true,
    };
    expect([...STRUCTURED_MANAGER_EVENT_NAMES].sort()).toEqual(Object.keys(fromMap).sort());
  });

  it('fire and on carry the argument types of the map', () => {
    class Probe extends StructuredEmitter {
      go() {
        this.fire('exit', 't1', 0, 'stderr tail');
        this.fire('idle', 't1', { declared: true, state: 'done' });
        // @ts-expect-error exit takes a number code, not a string
        this.fire('exit', 't1', 'zero');
        // @ts-expect-error an event that is not in the map
        this.fire('made-up', 't1');
      }
    }
    const probe = new Probe();
    const seen: unknown[] = [];
    probe.on('exit', (terminalId, code, detail) => {
      expectTypeOf(terminalId).toEqualTypeOf<string>();
      expectTypeOf(code).toEqualTypeOf<number>();
      expectTypeOf(detail).toEqualTypeOf<string | undefined>();
      seen.push([terminalId, code, detail]);
    });
    probe.on('idle', (_id, detail) => { expectTypeOf(detail.declared).toEqualTypeOf<boolean>(); seen.push(detail); });
    probe.go();
    expect(seen).toEqual([['t1', 0, 'stderr tail'], { declared: true, state: 'done' }]);
  });

  it('IStructuredManager gives a listener the types of the map', () => {
    const typed = (m: IStructuredManager) => {
      m.on('permission', (terminalId, pending) => {
        expectTypeOf(terminalId).toEqualTypeOf<string>();
        expectTypeOf(pending).toEqualTypeOf<PendingPermission>();
      });
      m.on('needs-help', (_id, detail) => { expectTypeOf(detail.inferred).toEqualTypeOf<boolean>(); });
      // An event that is not in the map still compiles (the plain EventEmitter signature): the
      // listeners in sessions/service.ts are not moved in this wave.
      m.on('some-other-event', (..._args: unknown[]) => {});
    };
    expect(typeof typed).toBe('function');
  });
});
