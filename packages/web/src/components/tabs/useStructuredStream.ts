import { useEffect, useRef, useState } from 'react';
import type { ConvItem } from '../../api/types';
import { openStructuredSocket } from '../../api/structured-socket';

function toItems(event: any): ConvItem[] {
  const out: ConvItem[] = [];
  if (event?.type === 'assistant' && Array.isArray(event.message?.content)) {
    for (const b of event.message.content) {
      if (b.type === 'text' && b.text) out.push({ kind: 'assistant', text: b.text });
      else if (b.type === 'thinking') out.push({ kind: 'thinking', text: b.thinking ?? b.text ?? '' });
      else if (b.type === 'tool_use') out.push({ kind: 'tool', toolName: b.name, toolInput: safeJson(b.input), toolFile: b.input?.file_path ?? b.input?.path });
    }
  } else if (event?.type === 'user' && Array.isArray(event.message?.content)) {
    for (const b of event.message.content) {
      if (b.type === 'tool_result') out.push({ kind: 'tool-result', text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content), isError: b.is_error === true });
    }
  }
  return out;
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

export function useStructuredStream(terminalId: string): ConvItem[] {
  const [items, setItems] = useState<ConvItem[]>([]);
  useEffect(() => {
    if (!terminalId) return;
    setItems([]);
    const sock = openStructuredSocket({
      terminalId,
      onEvent: (e) => {
        const mapped = toItems(e);
        if (mapped.length) setItems((prev) => [...prev, ...mapped]);
      },
      onReset: () => setItems([]),
    });
    return () => sock.close();
  }, [terminalId]);
  return items;
}
