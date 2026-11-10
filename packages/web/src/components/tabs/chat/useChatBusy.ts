import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../api/client';
import type { StatusSnapshot } from '../../../api/types';

// "Is a turn in flight?" for a structured chat (W3-C, one status authority).
//
// The daemon decides: the first frame of the structured socket is its status snapshot
// (`{ type: 'system', subtype: 'status', turnOpen, generation, sequence, ... }`) and each committed
// transition sends the same frame. `busy = snapshot.turnOpen || sending`. The client no longer works it
// out from the frames it happens to see: a replay that ends mid-turn, a missed result or a dead process
// cannot leave "Working" on screen.
//
// A daemon from before v4.5.0 sends no status frame. For it, and only for it, the old fold of the frames
// stays (legacyBusyOf, the one branch in `frame`).

/** A send with no status frame after this long reads the snapshot by REST. */
export const SENDING_FALLBACK_MS = 10_000;

/** The status frame of the daemon. The CLI's own `system/status` frame (compaction) has no `turnOpen`. */
export function isStatusFrame(event: unknown): event is StatusSnapshot {
  const e = event as { type?: unknown; subtype?: unknown; turnOpen?: unknown; generation?: unknown; sequence?: unknown } | null;
  return !!e && e.type === 'system' && e.subtype === 'status'
    && typeof e.turnOpen === 'boolean' && typeof e.generation === 'number' && typeof e.sequence === 'number';
}

function isSnapshot(value: unknown): value is StatusSnapshot {
  const v = value as { turnOpen?: unknown; generation?: unknown; sequence?: unknown } | null;
  return !!v && typeof v.turnOpen === 'boolean' && typeof v.generation === 'number' && typeof v.sequence === 'number';
}

/** Negative when `a` is older than `b`: a lower generation, or a lower sequence in the same generation. */
export function compareStatus(a: StatusSnapshot, b: StatusSnapshot): number {
  return a.generation - b.generation || a.sequence - b.sequence;
}

/**
 * OLD DAEMON ONLY. What the frame fold of the client before v4.5.0 took a frame to mean for "busy":
 * true, false, or undefined for "no change". Used only on a connection that sent no status frame.
 * REMOVE with the support of a daemon before v4.5.0.
 */
export function legacyBusyOf(event: any): boolean | undefined {
  const type = event?.type;
  if (type === 'system' && event.subtype === 'spawn_error') return false;
  if (type === 'permission') return event.pending ? false : undefined;
  if (type === 'stream_event' && event.event) return true;
  if (type === 'assistant' && Array.isArray(event.message?.content)) return true;
  if (type === 'result') return false;
  return undefined;
}

export interface ChatBusy {
  busy: boolean;
  /** Each frame of the socket, before the fold. True when it was a status frame (the fold then skips it). */
  frame: (event: unknown) => boolean;
  /** A reconnection opened: the header of the new connection decides. */
  socketReset: () => void;
  /** The socket closed: nothing is known until the next header. */
  socketClosed: () => void;
  /** A message, an answer or a reply is on its way to the daemon: busy until the daemon's status says so. */
  beginSending: () => void;
  /** The daemon accepted it (the POST answered). */
  sendAccepted: () => void;
  /** It failed, or no turn will come of it. */
  sendFailed: () => void;
}

export function useChatBusy(terminalId: string): ChatBusy {
  // The snapshot shown. Null: this daemon sent no status frame (yet), so the fold decides.
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null);
  const [legacyBusy, setLegacyBusy] = useState(false);
  const [sending, setSending] = useState(false);

  const lastRef = useRef<StatusSnapshot | null>(null);   // the newest snapshot taken, for the order check
  const authorityRef = useRef(false);                    // mirrors `snapshot !== null`
  const headerSeenRef = useRef(false);                   // this connection sent a status frame
  const sendRef = useRef<{ baseline: StatusSnapshot | null; accepted: boolean; timer: ReturnType<typeof setTimeout> } | null>(null);
  const terminalRef = useRef(terminalId);
  terminalRef.current = terminalId;

  const endSending = useCallback(() => {
    if (sendRef.current) clearTimeout(sendRef.current.timer);
    sendRef.current = null;
    setSending(false);
  }, []);

  const applyStatus = useCallback((next: StatusSnapshot) => {
    const last = lastRef.current;
    if (last && compareStatus(next, last) < 0) return; // older than what is shown
    lastRef.current = next;
    authorityRef.current = true;
    setSnapshot(next);
    // `sending` lasts until the first status that is newer than the one at Send. One that says the turn
    // is closed counts only after the POST answered: before that it is the end of the turn before.
    const send = sendRef.current;
    if (send && (!send.baseline || compareStatus(next, send.baseline) > 0) && (next.turnOpen || send.accepted)) endSending();
  }, [endSending]);

  // A different thread: nothing of the one before is kept.
  useEffect(() => {
    lastRef.current = null; authorityRef.current = false; headerSeenRef.current = false;
    setSnapshot(null); setLegacyBusy(false);
    endSending();
    return () => { if (sendRef.current) { clearTimeout(sendRef.current.timer); sendRef.current = null; } };
  }, [terminalId, endSending]);

  const frame = useCallback((event: unknown): boolean => {
    if (isStatusFrame(event)) {
      headerSeenRef.current = true;
      const { status, turnOpen, generation, sequence, at, activity } = event;
      applyStatus({ status, turnOpen, generation, sequence, at, activity: activity ?? null });
      return true;
    }
    // The one branch for a daemon that sends no status frame: its connection starts with another frame.
    if (!headerSeenRef.current) {
      if (authorityRef.current) {
        // The page spoke to a newer daemon before (a rollback): its snapshot is not kept.
        authorityRef.current = false; lastRef.current = null;
        setSnapshot(null); setLegacyBusy(false);
      }
      const folded = legacyBusyOf(event);
      if (folded !== undefined) setLegacyBusy(folded);
    }
    return false;
  }, [applyStatus]);

  const socketReset = useCallback(() => {
    // The header that follows is taken as it is, whatever its order (a daemon restart counts from 0).
    headerSeenRef.current = false;
    lastRef.current = null;
    setLegacyBusy(false);
  }, []);

  const socketClosed = useCallback(() => {
    setLegacyBusy(false);
    setSnapshot((prev) => (prev && prev.turnOpen ? { ...prev, turnOpen: false } : prev));
  }, []);

  const beginSending = useCallback(() => {
    if (sendRef.current) clearTimeout(sendRef.current.timer);
    const id = terminalId;
    const timer = setTimeout(() => {
      const done = () => { if (sendRef.current?.timer === timer) endSending(); };
      api.getTerminalStatus(id)
        .then((read) => { if (terminalRef.current === id && isSnapshot(read)) applyStatus(read); }, () => { /* an older daemon, or offline */ })
        .then(done, done);
    }, SENDING_FALLBACK_MS);
    sendRef.current = { baseline: lastRef.current, accepted: false, timer };
    setSending(true);
    setLegacyBusy(true); // the fold's own rule for a send (a daemon with no status frame)
  }, [terminalId, applyStatus, endSending]);

  const sendAccepted = useCallback(() => { if (sendRef.current) sendRef.current.accepted = true; }, []);

  const sendFailed = useCallback(() => { endSending(); setLegacyBusy(false); }, [endSending]);

  const busy = snapshot ? snapshot.turnOpen || sending : legacyBusy;
  return { busy, frame, socketReset, socketClosed, beginSending, sendAccepted, sendFailed };
}
