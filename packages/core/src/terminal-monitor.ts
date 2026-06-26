import type { EventBroadcaster } from './ws/events.js';
import type Database from 'better-sqlite3';

interface TerminalStatus {
  terminalId: string;
  activity: 'busy' | 'idle';
  lastOutput: number;
  connectedAt: number;
  model?: string;
  context?: string;
  cost?: string;
  tokens?: string;
  percentage?: string;
  version?: string;
  sessionId?: string;
}

// Strip ANSI escape codes
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b\([A-Za-z]/g, '');
}

function parseStatusBar(text: string): Partial<TerminalStatus> {
  const stripped = stripAnsi(text);
  const result: Partial<TerminalStatus> = {};

  // Cost and tokens: "$0.22 (20,312 tokens)"
  const costMatch = stripped.match(/\$([0-9]+\.?[0-9]*)\s*\(([0-9,]+)\s*tokens?\)/);
  if (costMatch) {
    result.cost = '$' + costMatch[1];
    result.tokens = costMatch[2];
  }

  // Model and context: "Opus 4.6 (1M context)"
  const modelMatch = stripped.match(/(Opus|Sonnet|Haiku)\s+([0-9.]+)\s*\(([^)]*context)\)/);
  if (modelMatch) {
    result.model = `${modelMatch[1]} ${modelMatch[2]}`;
    result.context = modelMatch[3].replace('context', '').trim();
  }

  // Percentage: number followed by %
  const pctMatch = stripped.match(/(\d+)%/);
  if (pctMatch) {
    result.percentage = pctMatch[1] + '%';
  }

  // Version: v2.1.81
  const verMatch = stripped.match(/v(\d+\.\d+\.\d+)/);
  if (verMatch) {
    result.version = 'v' + verMatch[1];
  }

  // Session ID: id:783b4...
  const idMatch = stripped.match(/id:([a-f0-9]+)/);
  if (idMatch) {
    result.sessionId = idMatch[1];
  }

  return result;
}

export class TerminalMonitor {
  private statuses = new Map<string, TerminalStatus>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private burstBytes = new Map<string, number>();
  private broadcaster: EventBroadcaster;
  private db: Database.Database | null = null;
  private onActivity?: (terminalId: string, activity: 'busy' | 'idle') => void;
  private idleThresholdMs = 3000;
  /** Grace period after first tracking a terminal — ignore busy transitions */
  private connectionGraceMs = 5000;
  /** Minimum bytes of output before marking as busy (filters resize redraws & typing echo) */
  private busyThresholdBytes = 500;

  constructor(
    broadcaster: EventBroadcaster,
    db?: Database.Database,
    onActivity?: (terminalId: string, activity: 'busy' | 'idle') => void,
  ) {
    this.broadcaster = broadcaster;
    this.db = db || null;
    this.onActivity = onActivity;
  }

  /** Call this every time PTY output arrives for a terminal */
  onOutput(terminalId: string, data: string | Buffer) {
    const text = typeof data === 'string' ? data : data.toString('utf-8');
    const now = Date.now();

    let status = this.statuses.get(terminalId);
    if (!status) {
      status = { terminalId, activity: 'idle', lastOutput: now, connectedAt: now };
      this.statuses.set(terminalId, status);
    }

    const inGracePeriod = (now - status.connectedAt) < this.connectionGraceMs;

    // Track output volume — only mark busy after substantial output
    const currentBurst = (this.burstBytes.get(terminalId) || 0) + text.length;
    this.burstBytes.set(terminalId, currentBurst);

    if (status.activity === 'idle' && !inGracePeriod && currentBurst >= this.busyThresholdBytes) {
      status.activity = 'busy';
      this.broadcast(terminalId, status);
    }
    status.lastOutput = now;

    // Parse status bar info from the output
    const parsed = parseStatusBar(text);
    let changed = false;
    for (const [key, value] of Object.entries(parsed)) {
      if (value && (status as any)[key] !== value) {
        (status as any)[key] = value;
        changed = true;
      }
    }
    if (changed) {
      this.broadcast(terminalId, status);
    }

    // Reset idle timer
    const existing = this.idleTimers.get(terminalId);
    if (existing) clearTimeout(existing);
    this.idleTimers.set(terminalId, setTimeout(() => {
      if (status) {
        status.activity = 'idle';
        this.burstBytes.set(terminalId, 0);
        this.broadcast(terminalId, status);
        // Bump last_activity_at only. The thread STATUS column is owned by the
        // StatusService (Claude hooks / Codex notify) — writing 'waiting' here on
        // every output pause is what made status flap mid-turn, so we don't.
        if (this.db) {
          const now = new Date().toISOString();
          try {
            const row = this.db.prepare('SELECT session_id FROM terminals WHERE id = ?').get(terminalId) as any;
            if (row?.session_id) {
              this.db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(now, row.session_id);
              this.db.prepare('UPDATE terminals SET last_activity_at = ? WHERE id = ?').run(now, terminalId);
            }
          } catch {}
        }
      }
    }, this.idleThresholdMs));
  }

  /** Get current status for a terminal */
  getStatus(terminalId: string): TerminalStatus | undefined {
    return this.statuses.get(terminalId);
  }

  /** Remove tracking for a terminal */
  remove(terminalId: string) {
    this.statuses.delete(terminalId);
    this.burstBytes.delete(terminalId);
    const timer = this.idleTimers.get(terminalId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(terminalId);
  }

  private broadcast(terminalId: string, status: TerminalStatus) {
    this.onActivity?.(terminalId, status.activity);
    this.broadcaster.broadcast({
      type: 'terminal:activity',
      terminalId,
      activity: status.activity,
      model: status.model || null,
      context: status.context || null,
      cost: status.cost || null,
      tokens: status.tokens || null,
      percentage: status.percentage || null,
      version: status.version || null,
      sessionId: status.sessionId || null,
    });
  }
}
