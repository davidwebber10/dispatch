// Which reasoning efforts a Codex model takes. They differ by model: live-checked on codex-cli
// (`model/list`, 2026-11-06), every model has low to max, and the Sol, Terra and Astra models also
// have ultra; the Luna models stop at max. The running app-server's own `model/list` is the source of
// truth (CodexStructuredSessionManager.loadModelEfforts); this table is only the fallback for when no
// app-server is running, or it does not list the model. Pure, so the web uses it too.

/** What every Codex model takes. Used when the model is not known. */
export const CODEX_COMMON_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Every effort any Codex model takes. */
export const CODEX_ALL_EFFORTS: readonly string[] = [...CODEX_COMMON_EFFORTS, 'ultra'];

const WITH_ULTRA = new Set(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra']);

/** The efforts `model` takes: the app-server's list when it gave one, else the table, else the common set. */
export function codexEffortsFor(model: string | null | undefined, live?: Record<string, readonly string[]> | null): readonly string[] {
  if (!model) return CODEX_COMMON_EFFORTS;
  const l = live?.[model];
  if (l?.length) return l;
  return WITH_ULTRA.has(model) ? CODEX_ALL_EFFORTS : CODEX_COMMON_EFFORTS;
}
