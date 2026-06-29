import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConvItem } from '../../../api/types';
import { openStructuredSocket } from '../../../api/structured-socket';
import { api } from '../../../api/client';

export interface StructuredChat {
  items: ConvItem[];
  busy: boolean;        // a turn is in flight (sent or streaming, no result yet)
  model?: string;
  send: (text: string) => void;
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

/** Best-effort file path from a (possibly complete) tool input JSON string. */
function fileFromInput(json: string): string | undefined {
  try {
    const o = JSON.parse(json);
    return o?.file_path ?? o?.path ?? undefined;
  } catch { return undefined; }
}

/** Tracks one in-progress streamed content block within the current turn. */
interface BlockRec { key: string; kind: 'assistant' | 'thinking' | 'tool'; jsonAccum?: string }

/**
 * Drives a structured (stream-json) thread for the chat UI. Opens the live ws,
 * folds raw events into a flat ConvItem timeline, pairs tool calls with their
 * results by id (robust to parallel/interleaved tools), captures the per-turn
 * `result` (cost/tokens/duration) and the model, and tracks a `busy` flag.
 *
 * AUTO-ADAPT streaming: once any `stream_event` is seen for the thread we set a
 * streaming flag and build the assistant side (text, thinking, tool_use args)
 * FROM the deltas, IGNORING the whole `assistant` event's blocks (to avoid
 * duplication) — though we still reconcile each tool_use's parsed input from the
 * whole event. If no stream_events ever arrive (older daemon), we fall back to
 * today's whole-`assistant` handling. tool_result still comes from `user` events,
 * the footer from `result`. The user's own turns arrive as echoed `user` text
 * blocks (the backend buffers them), so reconnect replay restores them.
 */
export function useStructuredChat(terminalId: string): StructuredChat {
  const [items, setItems] = useState<ConvItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<string | undefined>();

  // Streaming bookkeeping (refs so rapid deltas don't churn renders for tracking).
  const streamingRef = useRef(false);                 // sticky once any stream_event seen
  const turnRef = useRef(0);                           // monotonic turn id → unique block keys
  const blockMapRef = useRef<Map<number, BlockRec>>(new Map()); // content-block index → record

  useEffect(() => {
    if (!terminalId) { setItems([]); setBusy(false); setModel(undefined); return; }
    setItems([]); setBusy(false); setModel(undefined);
    streamingRef.current = false; turnRef.current = 0; blockMapRef.current.clear();

    const sock = openStructuredSocket({
      terminalId,
      onReset: () => {
        // Reconnect: server replays its buffer. Clear the view + per-turn tracking so
        // replayed deltas rebuild cleanly. `streamingRef` stays sticky (per-thread).
        setItems([]); setBusy(false);
        blockMapRef.current.clear();
      },
      onClose: () => {
        // P0b safety net: if the ws drops we can't trust an in-flight turn to ever
        // emit `result`, so stop spinning. A live reconnect re-sets busy via deltas.
        setBusy(false);
      },
      onEvent: (event: any) => {
        const type = event?.type;

        if (type === 'system' && event.subtype === 'init') {
          const m = event.model || event.session?.model || event.modelId;
          if (m) setModel(m);
          return;
        }

        // --- Streaming protocol (Anthropic stream_event) ---------------------
        if (type === 'stream_event' && event.event) {
          streamingRef.current = true;
          setBusy(true);
          const se = event.event;

          if (se.type === 'message_start') {
            turnRef.current += 1;
            blockMapRef.current.clear();
            return;
          }

          if (se.type === 'content_block_start') {
            const idx = se.index;
            const cb = se.content_block || {};
            const key = `s-${turnRef.current}-${idx}`;
            if (cb.type === 'text') {
              blockMapRef.current.set(idx, { key, kind: 'assistant' });
              setItems((p) => [...p, { kind: 'assistant', text: '', uuid: key }]);
            } else if (cb.type === 'thinking') {
              blockMapRef.current.set(idx, { key, kind: 'thinking' });
              setItems((p) => [...p, { kind: 'thinking', text: '', uuid: key }]);
            } else if (cb.type === 'tool_use') {
              blockMapRef.current.set(idx, { key, kind: 'tool', jsonAccum: '' });
              setItems((p) => [...p, { kind: 'tool', toolName: cb.name, toolId: cb.id, toolInput: '', uuid: key }]);
            }
            return;
          }

          if (se.type === 'content_block_delta') {
            const rec = blockMapRef.current.get(se.index);
            if (!rec) return;
            const d = se.delta || {};
            if (d.type === 'text_delta' && rec.kind === 'assistant') {
              const t = d.text ?? '';
              setItems((p) => p.map((it) => (it.uuid === rec.key ? { ...it, text: (it.text ?? '') + t } : it)));
            } else if (d.type === 'thinking_delta' && rec.kind === 'thinking') {
              const t = d.thinking ?? '';
              setItems((p) => p.map((it) => (it.uuid === rec.key ? { ...it, text: (it.text ?? '') + t } : it)));
            } else if (d.type === 'input_json_delta' && rec.kind === 'tool') {
              rec.jsonAccum = (rec.jsonAccum ?? '') + (d.partial_json ?? '');
              const accum = rec.jsonAccum;
              const file = fileFromInput(accum); // resolves once accum is complete JSON
              setItems((p) => p.map((it) => (it.uuid === rec.key ? { ...it, toolInput: accum, ...(file ? { toolFile: file } : {}) } : it)));
            }
            return;
          }

          // content_block_stop / message_delta / message_stop: nothing structural.
          return;
        }

        if (type === 'assistant' && Array.isArray(event.message?.content)) {
          setBusy(true);
          // Streaming mode: text/thinking already rendered from deltas — ignore them
          // to avoid duplication. Reconcile each tool_use's parsed input from the
          // authoritative whole event (and append any tool we never saw start, e.g.
          // if its content_block_start was trimmed out of the replay ring).
          if (streamingRef.current) {
            const tools = event.message.content.filter((b: any) => b.type === 'tool_use');
            if (tools.length) {
              setItems((p) => {
                const haveIds = new Set(p.filter((i) => i.kind === 'tool' && i.toolId).map((i) => i.toolId));
                const next = p.map((it) => {
                  if (it.kind !== 'tool' || !it.toolId) return it;
                  const m = tools.find((b: any) => b.id === it.toolId);
                  return m ? { ...it, toolInput: safeJson(m.input), toolFile: m.input?.file_path ?? m.input?.path ?? it.toolFile } : it;
                });
                for (const b of tools) {
                  if (!haveIds.has(b.id)) next.push({ kind: 'tool', toolName: b.name, toolId: b.id, toolInput: safeJson(b.input), toolFile: b.input?.file_path ?? b.input?.path });
                }
                return next;
              });
            }
            return;
          }
          // Fallback (no stream_events ever arrived): build from the whole event.
          const add: ConvItem[] = [];
          for (const b of event.message.content) {
            if (b.type === 'text' && b.text) add.push({ kind: 'assistant', text: b.text });
            else if (b.type === 'thinking') add.push({ kind: 'thinking', text: b.thinking ?? b.text ?? '' });
            else if (b.type === 'tool_use') add.push({ kind: 'tool', toolName: b.name, toolId: b.id, toolInput: safeJson(b.input), toolFile: b.input?.file_path ?? b.input?.path });
          }
          if (add.length) setItems((p) => [...p, ...add]);
          return;
        }

        if (type === 'user' && Array.isArray(event.message?.content)) {
          const add: ConvItem[] = [];
          for (const b of event.message.content) {
            if (b.type === 'tool_result') {
              add.push({ kind: 'tool-result', toolId: b.tool_use_id, text: typeof b.content === 'string' ? b.content : safeJson(b.content), isError: b.is_error === true });
            } else if (b.type === 'text' && b.text) {
              // P0a: the backend buffers/echoes the user's own turn as a text block.
              add.push({ kind: 'user', text: b.text });
            }
          }
          if (add.length) setItems((p) => [...p, ...add]);
          return;
        }

        if (type === 'result') {
          setBusy(false);
          setItems((p) => [...p, {
            kind: 'result',
            isError: event.is_error === true,
            costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined,
            turns: typeof event.num_turns === 'number' ? event.num_turns : undefined,
            durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : undefined,
            tokensIn: event.usage?.input_tokens,
            tokensOut: event.usage?.output_tokens,
            text: typeof event.result === 'string' && event.is_error ? event.result : undefined,
          }]);
          return;
        }
      },
    });
    return () => sock.close();
  }, [terminalId]);

  const send = useCallback((text: string) => {
    const v = text.trim();
    if (!v || !terminalId) return;
    // No optimistic user bubble: the backend echoes the turn as a `user` text event
    // (which also survives reconnect replay), so an optimistic append would double up.
    setBusy(true);
    api.sendStructuredMessage(terminalId, v).catch(() => {
      // P0c: the POST rejects (e.g. the claude process died → 400) — surface it and
      // stop spinning instead of leaving "Working…" forever.
      setBusy(false);
      setItems((p) => [...p, { kind: 'result', isError: true, text: 'Failed to send message' }]);
    });
  }, [terminalId]);

  return { items, busy, model, send };
}
