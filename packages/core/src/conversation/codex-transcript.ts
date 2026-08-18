/**
 * Parses a Codex rollout transcript
 * (~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl) into the same flat
 * `ConvItem[]` the Claude Code parser produces, so Pretty can page a Codex thread's
 * history through the identical REST path.
 *
 * Codex writes TWO overlapping families of line, and reading both renders the whole
 * conversation twice:
 *
 *   - `response_item` — the model-facing record: messages, reasoning, tool calls and
 *     tool outputs. Complete and self-consistent. This is the one we read.
 *   - `event_msg`     — the UI event stream (agent_message, user_message, token_count,
 *     task_started …). A sampled 6995-line transcript held 179 `event_msg/agent_message`
 *     against exactly 179 assistant `response_item/message` — the same turns, twice.
 *
 * Two further families are skipped for cause, not oversight:
 *
 *   - `reasoning` carries its text in `encrypted_content`; `summary` was empty on all
 *     1553 reasoning lines in that transcript. There is nothing readable to render.
 *   - `response_item/agent_message` is inter-agent traffic, not the assistant speaking —
 *     its 146 lines match the 146 `inter_agent_communication_metadata` lines one-for-one.
 *
 * Unlike a Claude Code transcript, a rollout line carries NO `uuid`. Items therefore come
 * back without one, and paging anchors on the line index (`before`) instead. See
 * SessionService.getConversation.
 */

import type { ConvItem } from './transcript.js';

export function parseCodexRollout(text: string): ConvItem[] {
  const items: ConvItem[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try { obj = JSON.parse(trimmed); } catch { continue; } // partial/garbled line
    items.push(...parseLine(obj));
  }
  return items;
}

function parseLine(o: unknown): ConvItem[] {
  if (!o || typeof o !== 'object') return [];
  const line = o as Record<string, unknown>;
  // Only the model-facing family — see the header note on the event_msg duplication.
  if (line.type !== 'response_item') return [];
  const p = line.payload;
  if (!p || typeof p !== 'object') return [];
  const payload = p as Record<string, unknown>;
  const ts = str(line.timestamp);

  switch (payload.type) {
    case 'message':
      return message(payload, ts);
    case 'function_call':
      return tool(str(payload.name), str(payload.arguments), ts);
    case 'custom_tool_call':
      // `input` is a plain string here, where function_call uses `arguments`.
      return tool(str(payload.name), str(payload.input), ts);
    case 'function_call_output':
    case 'custom_tool_call_output':
      return toolResult(payload.output, ts);
    default:
      // reasoning, agent_message, and anything Codex adds later.
      return [];
  }
}

function message(payload: Record<string, unknown>, ts?: string): ConvItem[] {
  const role = str(payload.role);
  // `developer` is the harness injecting instructions, not a turn in the conversation.
  if (role !== 'user' && role !== 'assistant') return [];
  const content = payload.content;
  if (!Array.isArray(content)) return [];

  const out: ConvItem[] = [];
  const texts: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    // input_text on a human turn, output_text on the assistant's.
    if (block.type === 'input_text' || block.type === 'output_text') {
      const t = str(block.text);
      if (t) texts.push(t);
    } else if (block.type === 'input_image') {
      const url = str(block.image_url) ?? str(block.url);
      if (url) out.push({ kind: 'image', imageUrl: url, imageFromUser: role === 'user', ts });
    }
  }
  // One item per turn, not one per block — a turn split across blocks is still one bubble.
  if (texts.length) out.unshift({ kind: role, text: texts.join('\n'), ts });
  return out;
}

function tool(toolName?: string, toolInput?: string, ts?: string): ConvItem[] {
  if (!toolName) return [];
  return [{ kind: 'tool', toolName, ...(toolInput ? { toolInput } : {}), ts }];
}

function toolResult(output: unknown, ts?: string): ConvItem[] {
  const text = flattenOutput(output);
  if (text == null) return [];
  return [{ kind: 'tool-result', text, ts }];
}

/**
 * A tool output is a plain string on `function_call_output` but an array of text blocks
 * on `custom_tool_call_output`. Both reduce to one string.
 */
function flattenOutput(output: unknown): string | undefined {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const raw of output) {
      if (typeof raw === 'string') { parts.push(raw); continue; }
      if (raw && typeof raw === 'object') {
        const t = str((raw as Record<string, unknown>).text);
        if (t) parts.push(t);
      }
    }
    return parts.join('\n');
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
