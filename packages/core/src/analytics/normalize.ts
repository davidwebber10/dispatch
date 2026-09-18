import type { Measurement, Tokens } from '../db/telemetry.js';
import { usageFromFrame } from './frames.js';

const zero: Tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };

/** All adapters feed this envelope. No database or lifecycle side effects here. */
export function measurementsFromFrame(frame: unknown): Measurement[] {
  if (!frame || typeof frame !== 'object') return [];
  const f = frame as any;
  if (f.telemetry?.displayOnly) return [];
  const counter = f.telemetry?.counter;
  const usage = counter ? usageFromFrame({ ...f, subtype: 'usage' }) : usageFromFrame(f);
  const sessionId = typeof f.session_id === 'string' ? f.session_id : f.telemetry?.sessionId;
  const eventId = f.message?.id ?? f.telemetry?.eventId ?? f.uuid;
  const out: Measurement[] = [];
  if (usage) out.push({
    ...usage, source: 'structured', sessionId, eventId,
    ...(counter ? { counter } : {}),
    coverage: f.telemetry?.coverage ?? (eventId || counter ? 'reported' : 'partial'),
  });
  for (const block of Array.isArray(f.message?.content) ? f.message.content : []) {
    if (block?.type !== 'tool_use') continue;
    out.push({ ...zero, model: f.message?.model ?? '', source: 'structured', sessionId,
      eventId: block.id ?? eventId, kind: 'tool', toolCalls: 1 });
  }
  return out;
}

/** Codex exec reports a per-turn aggregate; it is not the app-server cumulative gauge. */
export function codexRunnerFrame(frame: unknown): unknown {
  const f = frame as any;
  if (f?.type !== 'turn.completed' || !f.usage) return frame;
  const u = f.usage;
  return { type: 'assistant', message: { model: f.model, content: [], usage: {
    input_tokens: Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)),
    cache_read_input_tokens: u.cached_input_tokens ?? 0, output_tokens: u.output_tokens ?? 0,
  } }, telemetry: { eventId: f.turn_id, coverage: 'partial' } };
}

/**
 * Claude's streaming result modelUsage is cumulative within one CLI invocation,
 * including subagents. Assistant output_tokens is a placeholder, so use final
 * per-model counters for usage and retain assistant frames only for tool counts.
 * https://code.claude.com/docs/en/agent-sdk/cost-tracking#track-costs-in-streaming-input-mode
 */
export function claudeMeasurements(frame: unknown): Measurement[] {
  const f = frame as any;
  const scope = f?.telemetry?.counterScope;
  if (!scope) return measurementsFromFrame(frame);
  if (f.type !== 'result') return measurementsFromFrame(frame).filter(m => m.kind === 'tool');
  const sessionId = f.session_id;
  const out: Measurement[] = [];
  for (const [model, raw] of Object.entries(f.modelUsage ?? {})) {
    const u = raw as any;
    if (!u || typeof u !== 'object') continue;
    const totals = { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0,
      cacheRead: u.cacheReadInputTokens ?? 0, cacheCreate: u.cacheCreationInputTokens ?? 0 };
    out.push({ ...totals, model, sessionId, source: 'structured', coverage: 'reported',
      counter: { key: `claude:${scope}:${model}`, totals, initialIsDelta: true, final: true } });
  }
  // Older CLI versions may omit modelUsage. The turn total excludes subagents
  // and has no trustworthy per-model attribution; expose that loss as partial.
  if (!out.length && f.usage && Object.values(f.usage).some(v => typeof v === 'number')) {
    const usage = usageFromFrame({ message: { usage: f.usage } });
    if (usage) out.push({ ...usage, sessionId, source: 'structured', eventId: f.uuid, coverage: 'partial' });
  }
  if (typeof f.total_cost_usd === 'number' && Number.isFinite(f.total_cost_usd) && f.total_cost_usd >= 0) {
    out.push({ ...zero, model: '', sessionId, source: 'structured', kind: 'cost', reportedCostUsd: f.total_cost_usd,
      counter: { key: `claude:${scope}:cost`, totals: { ...zero, input: f.total_cost_usd }, unit: 'usd', initialIsDelta: true, final: true } });
  }
  return out;
}
