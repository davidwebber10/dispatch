import type http from 'http';
import type { Duplex } from 'node:stream';
import type { WebSocketServer } from 'ws';
import { upgradeAllowed } from '../auth/box-token.js';
import { socketAllowedForProfile, socketRouteOf, type ProfileSource } from '../profile/business-gate.js';
import { upgradePathIsCanonical } from '../http/canonical-path.js';
import type { AccessGate } from '../auth/access-gate.js';
import type { DeviceStore } from '../auth/devices.js';
import { refuseKeyUpgrade } from '../auth/request-principal.js';
import { looksLikeBrowser } from '../auth/route-policy.js';
import { createClientWss } from '../ws/client-wss.js';
import { wsMaxPayload, wsTerminalMaxPayload } from '../caps.js';
import { answerEventsPing } from '../ws/events.js';
import { handleTerminalConnection } from '../ws/terminal.js';
import { handleStructuredConnection } from '../ws/structured.js';
import type { SessionService } from '../sessions/service.js';
import type { StatusService } from '../status/service.js';
import type { TerminalMonitor } from '../terminal-monitor.js';
import type { IStructuredManager } from '../structured/manager.js';
import { stripPrefix } from './base-path.js';
import type { PtyLike } from './noop-pty.js';

/** The three WebSocket servers of the daemon (noServer mode: `attach` routes the upgrades to them). */
export interface DaemonSockets {
  events: WebSocketServer;
  terminal: WebSocketServer;
  structured: WebSocketServer;
  all: WebSocketServer[];
}

export function createDaemonSockets(): DaemonSockets {
  // maxPayload: one client message over the cap closes that socket (the default of ws is 100 MiB).
  const events = createClientWss(wsMaxPayload(), { deflate: true }); // JSON text: permessage-deflate (ws/client-wss.ts)
  const terminal = createClientWss(wsTerminalMaxPayload()); // typed and pasted input comes through this one
  const structured = createClientWss(wsMaxPayload(), { deflate: true });
  return { events, terminal, structured, all: [events, terminal, structured] };
}

export interface UpgradeInputs {
  sockets: DaemonSockets;
  basePath: string;
  boxToken: string | undefined;
  /** The business profile opens no PTY terminal socket (profile/business-gate.ts). Absent: developer. */
  profile?: ProfileSource;
  /** The saved type and config of a thread (for the business profile: only a chat thread's stream opens). */
  threadFacts?: (id: string) => { type: string; config: Record<string, unknown> } | null;
  accessGate: AccessGate | undefined;
  devices: DeviceStore | undefined;
  sessionService: SessionService;
  statusService: StatusService;
  ptyManager: PtyLike;
  terminalMonitor: TerminalMonitor;
  /** The fallback manager of the structured socket. */
  claudeManager: IStructuredManager;
}

/**
 * The handler of the HTTP `upgrade` event. Express middleware never runs for an upgrade, so every check
 * of the HTTP side is repeated here: the mount prefix, the box token, the access gate, and "no key opens a socket".
 */
export function createUpgradeHandler(i: UpgradeInputs): (request: http.IncomingMessage, socket: Duplex, head: Buffer) => void {
  const { sockets, accessGate, devices, sessionService } = i;
  // Open WebSockets by device id. A revoke destroys them: the cookie is checked only at connect.
  const deviceSockets = new Map<string, Set<Duplex>>();
  const legacySockets = new Map<Duplex, string>();
  const trackDeviceSocket = (id: string, socket: Duplex) => {
    let set = deviceSockets.get(id);
    if (!set) deviceSockets.set(id, set = new Set());
    set.add(socket);
    socket.once('close', () => { set!.delete(socket); if (!set!.size) deviceSockets.delete(id); });
  };
  devices?.onAdopt((key, id) => {
    for (const [s, k] of legacySockets) if (k === key) { legacySockets.delete(s); trackDeviceSocket(id, s); }
  });
  devices?.onEndLegacy(() => { for (const s of legacySockets.keys()) s.destroy(); legacySockets.clear(); });
  devices?.onRevoke((id) => { for (const s of deviceSockets.get(id) ?? []) s.destroy(); deviceSockets.delete(id); });

  const handleUpgrade = async (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    // Node removes its own error listener before 'upgrade' fires, and ws adds one only inside
    // handleUpgrade. The gate below awaits (it may run the tailscale CLI), so without this a
    // peer reset in that window is an uncaught ECONNRESET that kills the daemon.
    socket.on('error', () => socket.destroy());
    // The WS handler needs the same prefix strip as the HTTP side. Easy to overlook:
    // the two terminal regexes are unanchored so they'd still match a prefixed URL,
    // but the `url === '/api/events'` equality below would silently stop matching and
    // the events socket would just never connect.
    const stripped = stripPrefix(request.url || '', i.basePath);
    if (stripped === null) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    // Express middleware never runs for an upgrade, so the box-token check has to be
    // repeated here. Protecting only the HTTP routes would leave every terminal and
    // structured socket — full interactive access to the box — wide open.
    if (!upgradeAllowed(i.boxToken, request)) {
      // A real HTTP answer, not a dropped socket: a client (and the router's logs) can tell
      // "refused" from "the box is down" (box defects 2026-11-11, #9).
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: application/json\r\nX-Content-Type-Options: nosniff\r\nContent-Length: 26\r\n\r\n{"error":"unauthorized"}\r\n');
      return;
    }
    const url = stripped;
    // One spelling per socket, as for the HTTP routes (http/canonical-path.ts), and ONE table of sockets
    // (profile/business-gate.ts SOCKET_ROUTES), matched on the whole path. A path that is not canonical,
    // or that names no socket, opens nothing: there is no second, looser match further down.
    // Answered after the gate below, so a caller with no credential learns nothing about which paths exist.
    const target = upgradePathIsCanonical(url) ? socketRouteOf(url) : null;
    // SEC-05 middle: the owner's credential, or a browser handshake (which always carries Origin), may type
    // into a terminal. A credential-free program may watch it. Keys never reach here (refused below).
    let allowInput = true;
    if (accessGate) {
      const d = await accessGate.upgradeDecision(request, url);
      if (socket.destroyed) return;
      if (d.ok) allowInput = d.via === 'credential' || looksLikeBrowser(request.headers);
      if (!d.ok) {
        socket.end(`HTTP/1.1 ${d.status} ${d.status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      // Remember which device owns this socket, so revoking the device closes it.
      let deviceId = d.credential?.kind === 'cookie' ? d.credential.deviceId : null;
      if (d.credential?.kind === 'cookie' && !deviceId && devices) {
        // The shared cookie from before the device list. If this browser was just made a device, the socket
        // belongs to it. If not, hold it by browser+address: the browser's next HTTP request adopts it
        // (onAdopt above), and "end older sign-ins" closes whatever is still held here.
        const key = accessGate.legacyKey(request);
        deviceId = devices.recentAdoption(key);
        if (!deviceId) {
          legacySockets.set(socket, key);
          socket.once('close', () => legacySockets.delete(socket));
        }
      }
      if (deviceId) trackDeviceSocket(deviceId, socket);
    }
    // No key opens a WebSocket (spec 6.4): the browser owns these sockets.
    if (refuseKeyUpgrade(request)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (!target) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    // The business profile: the terminal sockets are refused, and the chat stream opens only for a
    // thread a business person may drive. Decided from the socket that matched, never from the URL text.
    const id = target.param;
    const thread = target.route.id === 'structured' && id ? (i.threadFacts?.(id) ?? null) : null;
    if (!socketAllowedForProfile(i.profile ?? 'developer', target.route, thread)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }

    if (target.route.id === 'structured') {
      sockets.structured.handleUpgrade(request, socket, head, (ws) => {
        // Pick the RIGHT manager for this terminal's harness (claude stream-json vs codex
        // app-server) — both satisfy IStructuredManager, so the ws handler is transport-agnostic.
        // Falls back to the Claude manager when the terminal/type can't be resolved yet.
        const manager = (id && sessionService.structuredManagerForTerminal(id)) || i.claudeManager;
        handleStructuredConnection(
          ws, request, manager,
          (tid) => sessionService.ensureStructuredAlive(tid),
          (tid) => sessionService.historyOwnedByRest(tid),
          (tid) => sessionService.historyRestPageable(tid),
          // Settled = the daemon's own status row says the thread is not mid-turn. Drives
          // the phantom-"Working…" settle for replays that end mid-turn (see ws/structured.ts).
          (tid) => sessionService.getTerminal(tid)?.status !== 'working',
          (tid) => sessionService.activeModel(tid),
          (tid) => sessionService.getPendingPermission(tid),
          i.statusService, // W3-C: the status header and the live status frame
        );
      });
    } else if (target.route.id === 'terminal' || target.route.id === 'terminal-legacy') {
      sockets.terminal.handleUpgrade(request, socket, head, (ws) => {
        handleTerminalConnection(ws, request, i.ptyManager, sessionService, i.terminalMonitor, i.statusService, allowInput);
      });
    } else {
      sockets.events.handleUpgrade(request, socket, head, (ws) => {
        answerEventsPing(ws);
        sockets.events.emit('connection', ws, request);
      });
    }
  };
  // The gate is async (it may ask the tailscale CLI), so the whole handler waits for it.
  // A socket that is not admitted gets an HTTP status line and is closed.
  return (request, socket, head) => { void handleUpgrade(request, socket, head).catch(() => socket.destroy()); };
}
