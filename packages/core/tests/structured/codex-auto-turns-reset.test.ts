// Final review N4: only the person's message resets the count of automatic turns and ends the pause after
// Stop; a peer's message (coordinator) or the daemon's own (no source) changes neither.
import { it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexStructuredSessionManager } from '../../src/structured/codex-manager.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-codex-app-server.mjs');
let m: CodexStructuredSessionManager;
afterEach(() => m?.killAll());

it('a daemon or peer message keeps the count and the pause; the person resets both', async () => {
  m = new CodexStructuredSessionManager();
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd() });
  const session = (m as any).sessions.get('t1');
  const set = () => { session.autoTurns = 3; session.capNoticed = true; session.deliveryPaused = true; };
  const state = () => ({ autoTurns: session.autoTurns, capNoticed: session.capNoticed, deliveryPaused: session.deliveryPaused });
  set(); m.sendMessage('t1', 'Continue where you stopped.');
  expect(state()).toEqual({ autoTurns: 3, capNoticed: true, deliveryPaused: true });
  set(); m.sendMessage('t1', 'A note from another thread.', 'coordinator');
  expect(state()).toEqual({ autoTurns: 3, capNoticed: true, deliveryPaused: true });
  set(); m.sendMessage('t1', 'Go on, please.', 'user');
  expect(state()).toEqual({ autoTurns: 0, capNoticed: false, deliveryPaused: false });
});
