// packages/core/src/structured/codex-fast.ts
// Codex fast mode on a hosted box (2026-11-12, the owner: "it should just use fast mode"). A hosted
// Codex thread asks the app-server for the fast service tier on every thread/start and thread/resume,
// for each model whose model/list entry offers that tier (all current ones do: id `priority`, shown as
// "Fast"). No switch for the person. A local install is unchanged.
//
// Kill switch without an image build, like Ask's FAST_MODE_MODELS: the task environment
//   DISPATCH_CODEX_SERVICE_TIER=off   (or empty)  no tier is sent: standard speed
//   DISPATCH_CODEX_SERVICE_TIER=<id>              another tier id from model/list (e.g. ultrafast)
// And Sol's reasoning effort when the person picked none (parity with Ask: low):
//   DISPATCH_CODEX_SOL_EFFORT=medium              another default for Sol threads (a test subset)
import { isHostedBox } from '../os/hosted-mode.js';

/** The fast tier's id in Codex's model/list (`serviceTiers[].id`, name "Fast"). */
export const CODEX_FAST_TIER = 'priority';
/** A Sol model id: gpt-6.1-sol, gpt-6-sol, gpt-5.6-sol. */
const SOL = /^gpt-[\d.]+-sol$/;

/**
 * The service tier a hosted Codex thread asks for, or undefined (standard speed). `tiersOf` gives the
 * tier ids model/list offers for a model, or null when the list was not read or does not name it: then
 * the tier is asked for (every listed model offers it), and a refusal is retried without it.
 */
export function codexServiceTier(
  model: string | undefined,
  tiersOf: (model: string) => string[] | null = () => null,
  env: NodeJS.ProcessEnv = process.env,
  hosted: boolean = isHostedBox(env),
): string | undefined {
  if (!hosted) return undefined;
  const raw = env.DISPATCH_CODEX_SERVICE_TIER;
  const tier = raw === undefined ? CODEX_FAST_TIER : raw.trim();
  if (!tier || /^(off|default|none|standard)$/i.test(tier)) return undefined;
  if (model) {
    const offered = tiersOf(model);
    if (offered && !offered.includes(tier)) return undefined;
  }
  return tier;
}

/** The effort a hosted Sol thread runs at when the person picked none: low (DISPATCH_CODEX_SOL_EFFORT changes it). */
export function codexDefaultEffort(
  model: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  hosted: boolean = isHostedBox(env),
): string | undefined {
  if (!hosted || !model || !SOL.test(model)) return undefined;
  const e = (env.DISPATCH_CODEX_SOL_EFFORT ?? 'low').trim().toLowerCase();
  return /^[a-z]+$/.test(e) ? e : 'low';
}

/** An app-server answer that refuses the service tier (its message names it). */
export function isTierRefusal(message: string): boolean {
  return /service[ _-]?tier|serviceTier|priority|fast mode/i.test(message);
}
