import type { IncomingMessage } from 'http';
import type { WebSocket } from 'ws';
import type { PTYManager } from '../pty/manager.js';
import type { SessionService } from '../sessions/service.js';
import { isPtyType } from '../db/terminals.js';

function parseReplayBytes(url: string | undefined): number | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url, 'http://dispatch.local');
    const raw = parsed.searchParams.get('replayBytes');
    if (!raw) return undefined;
    const requested = Number(raw);
    if (!Number.isFinite(requested) || requested <= 0) return undefined;
    return Math.min(Math.floor(requested), 4_000_000);
  } catch {
    return undefined;
  }
}

export function handleTerminalConnection(
  ws: WebSocket,
  req: IncomingMessage,
  ptyManager: PTYManager,
  sessionService?: SessionService,
): void {
  // Support both new URL pattern /api/terminals/:terminalId/ws
  // and legacy /api/sessions/:id/terminal
  let targetId: string | undefined;
  let isTerminalRoute = false;

  const terminalMatch = req.url?.match(/\/api\/terminals\/([^/]+)\/ws/);
  if (terminalMatch) {
    targetId = terminalMatch[1];
    isTerminalRoute = true;
  } else {
    const sessionMatch = req.url?.match(/\/api\/sessions\/([^/]+)\/terminal/);
    if (sessionMatch) {
      targetId = sessionMatch[1];
    }
  }

  if (!targetId) { ws.close(4000, 'Invalid URL'); return; }

  // Revive dead PTYs: after a reboot/server restart, the DB still has terminal
  // rows but the processes are gone. If this is a PTY-type terminal and its
  // process isn't alive, relaunch it (resumes via external_id when set).
  if (isTerminalRoute && sessionService && !ptyManager.isAlive(targetId)) {
    const terminal = sessionService.getTerminal(targetId);
    if (terminal && isPtyType(terminal.type)) {
      try { sessionService.relaunchTerminal(targetId); } catch {}
    }
  }

  if (isTerminalRoute && sessionService) {
    const terminal = sessionService.getTerminal(targetId);
    if (!terminal) {
      ws.close(4004, 'Terminal not found');
      return;
    }
    if (isPtyType(terminal.type) && !ptyManager.isAlive(targetId)) {
      ws.close(1011, 'Terminal process is not running');
      return;
    }
  }

  // Send scrollback buffer
  const replayBytes = parseReplayBytes(req.url);
  const buffer = ptyManager.getBuffer(targetId, replayBytes);
  if (buffer) ws.send(buffer);
  // A trimmed replay can't reconstruct a diff-painting TUI's screen (codex only
  // redraws changed cells, so the viewer would see just the actively-updating
  // rows on black). Deliver a SIGWINCH so the app repaints everything.
  if (buffer && !ptyManager.isReplayComplete(targetId, replayBytes)) {
    ptyManager.nudgeRepaint(targetId);
  }

  // Forward PTY output to WebSocket
  const onData = (id: string, data: string) => {
    if (id === targetId && ws.readyState === 1) ws.send(data);
  };
  ptyManager.on('data', onData);

  // Forward WebSocket input to PTY (handle resize messages too)
  ws.on('message', (msg, isBinary) => {
    const str = typeof msg === 'string' ? msg : Buffer.isBuffer(msg) ? msg.toString('utf-8') : String(msg);
    // Resize messages are JSON: {"type":"resize","cols":N,"rows":N}
    if (str.includes('"type":"resize"')) {
      try {
        const parsed = JSON.parse(str);
        if (parsed.type === 'resize' && typeof parsed.cols === 'number' && typeof parsed.rows === 'number') {
          ptyManager.resize(targetId!, parsed.cols, parsed.rows);
          return;
        }
      } catch {}
    }
    ptyManager.write(targetId!, str);
  });

  ws.on('close', () => {
    ptyManager.off('data', onData);
  });
}
