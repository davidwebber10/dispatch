/**
 * What doppler_get_secret returns, from a `/v3/configs/config/secret` response. A tool result
 * lands in the agent's transcript — and from there in the model provider's requests and on
 * disk — so by default this is facts only: whether the secret exists, its length, its type.
 * The value comes back only with `reveal`, and only the computed value: the raw form can hold
 * `${OTHER}` references and the note is free text. A missing name answers 200 with nulls.
 */
export function secretSummary(body: unknown, reveal: boolean): { exists: boolean; length?: number; type?: string; value?: string } {
  const v = (body as { value?: Record<string, unknown> | null } | null | undefined)?.value;
  const computed = typeof v?.computed === 'string' ? v.computed : typeof v?.raw === 'string' ? v.raw : null;
  if (computed === null) return { exists: false };
  if (reveal) return { exists: true, value: computed };
  const type = (v?.computedValueType as { type?: unknown } | null | undefined)?.type;
  return { exists: true, length: computed.length, ...(typeof type === 'string' ? { type } : {}) };
}
