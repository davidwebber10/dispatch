// packages/core/src/structured/manager.ts
import { EventEmitter } from 'events';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';

interface Session {
  child: ChildProcessWithoutNullStreams;
  rl: readline.Interface;
  events: unknown[]; // ring of recent events for replay
}

const MAX_EVENTS = 5000;

/**
 * Drives one `claude` stream-json process per structured terminal. Parallel to
 * PTYManager but its payload is structured JSON events (not raw bytes), so it has
 * its own consumers (the structured ws + the View adapter) — it does NOT feed the
 * xterm/runner data path. Permissions are auto-allowed (parity with today).
 */
export class StructuredSessionManager extends EventEmitter {
  private sessions = new Map<string, Session>();

  spawn(terminalId: string, opts: { command: string; args: string[]; workDir: string; env?: Record<string, string> }): number {
    if (this.sessions.has(terminalId)) this.kill(terminalId);
    const child = spawn(opts.command, opts.args, {
      cwd: opts.workDir,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    child.stdin.on('error', () => {}); // Fix 2: suppress EPIPE if child closes stdin while alive

    const rl = readline.createInterface({ input: child.stdout });
    const session: Session = { child, rl, events: [] };
    this.sessions.set(terminalId, session);
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: any;
      try { event = JSON.parse(trimmed); } catch { return; } // skip non-JSON noise
      session.events.push(event);
      if (session.events.length > MAX_EVENTS) session.events.shift();
      // Auto-allow tool permission requests — parity with --dangerously-skip-permissions.
      if (event?.type === 'control_request' && event?.request?.subtype === 'can_use_tool') {
        this.write(terminalId, {
          type: 'control_response',
          response: { subtype: 'success', request_id: event.request_id, response: { behavior: 'allow', updatedInput: event.request.input } },
        });
      }
      this.emit('event', terminalId, event);
    });

    child.on('exit', (code) => {
      // Fix 1: only clear the map if this child is still the current session
      // (a re-spawn may have already replaced it; its exit must not evict the new child)
      if (this.sessions.get(terminalId)?.child === child) {
        this.sessions.delete(terminalId);
      }
      this.emit('exit', terminalId, code ?? 0);
    });
    child.on('error', (err) => { this.emit('event', terminalId, { type: 'system', subtype: 'spawn_error', message: String(err) }); });

    return child.pid ?? -1;
  }

  private write(terminalId: string, obj: unknown): void {
    const s = this.sessions.get(terminalId);
    if (!s || !s.child.stdin.writable) return;
    s.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  sendMessage(terminalId: string, text: string): void {
    this.write(terminalId, { type: 'user', message: { role: 'user', content: text } });
  }

  kill(terminalId: string): void {
    const s = this.sessions.get(terminalId);
    if (!s) return;
    s.rl.close(); // Fix 3: close readline so buffered lines stop emitting after kill
    try { s.child.kill(); } catch { /* already gone */ }
    this.sessions.delete(terminalId);
  }

  isAlive(terminalId: string): boolean { return this.sessions.has(terminalId); }

  getEvents(terminalId: string): unknown[] { return [...(this.sessions.get(terminalId)?.events ?? [])]; } // Fix 4: return copy
}
