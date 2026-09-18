import type { Measurement } from '../db/telemetry.js';

export interface HarnessIdentity {
  terminalId: string;
  provider: string;
  generation: string;
  sequence: number;
  eventId: string;
  observedAt: string;
  sessionId?: string;
  turnId?: string;
  nativeTurnId?: string;
  transport: 'structured' | 'runner';
}
export interface TurnResult {
  declared?: boolean;
  state?: 'done' | 'blocked';
  blocker?: string;
  summary?: string;
  ask?: string;
  inferred?: boolean;
  activity?: string;
}
/** Dispatch's internal contract. Native chat frames remain a separate UI compatibility stream. */
export type HarnessEvent = HarnessIdentity & (
  | { type: 'process.started' }
  | { type: 'session.identified'; sessionId: string }
  | { type: 'turn.started' }
  | { type: 'usage.observed'; measurements: Measurement[] }
  | { type: 'permission.requested'; toolName?: string; questions?: unknown[] }
  | { type: 'permission.resolved' }
  | { type: 'turn.completed'; outcome: 'idle' | 'needs_help' | 'scheduled'; detail: TurnResult }
  | { type: 'turn.failed' }
  | { type: 'capture.failed'; reason: string }
  | { type: 'process.exited'; exitCode: number }
);
