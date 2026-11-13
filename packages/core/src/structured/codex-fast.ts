// packages/core/src/structured/codex-fast.ts
// Codex fast mode on a hosted box (2026-11-12, the owner: "it should just use fast mode"). A hosted
// Codex thread asks the app-server for the fast service tier on every thread/start and thread/resume,
// for each model whose model/list entry offers that tier (all current ones do: id `priority`, shown as
// "Fast"). No switch for the person. A local install is unchanged.
//
// Kill switch without an image build, like Ask's FAST_MODE_MODELS: the task environment
//   DISPATCH_CODEX_SERVICE_TIER=off   (or empty, 0, false, none, default)  standard speed
//   DISPATCH_CODEX_SERVICE_TIER=<id>              another tier id from model/list (e.g. ultrafast)
// And Sol's reasoning effort when the person picked none (parity with Ask: low):
//   DISPATCH_CODEX_SOL_EFFORT=medium              another default for Sol threads (a test subset);
//                                                 off (or empty, 0, false) leaves Codex's own default
import { isHostedBox } from '../os/hosted-mode.js';

/** The fast tier's id in Codex's model/list (`serviceTiers[].id`, name "Fast"). */
export const CODEX_FAST_TIER = 'priority';
/** The standard tier, asked for explicitly where leaving the field out keeps a thread's saved tier (a resume). */
export const CODEX_STANDARD_TIER = 'default';
/** The values that turn a switch off: empty, off, default, none, standard, 0, false, no. */
const OFF = /^(|off|default|none|standard|0|false|no)$/i;
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
  if (OFF.test(tier)) return undefined;
  if (model) {
    const offered = tiersOf(model);
    if (offered && !offered.includes(tier)) return undefined;
  }
  return tier;
}

/**
 * The effort a hosted Sol thread runs at when the person picked none: low. DISPATCH_CODEX_SOL_EFFORT sets
 * another (the caller checks it against the model's efforts); an OFF value means no default (Codex's own).
 */
export function codexDefaultEffort(
  model: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  hosted: boolean = isHostedBox(env),
): string | undefined {
  if (!hosted || !model || !SOL.test(model)) return undefined;
  const raw = env.DISPATCH_CODEX_SOL_EFFORT;
  const e = raw === undefined ? 'low' : raw.trim().toLowerCase();
  if (OFF.test(e)) return undefined;
  return /^[a-z]+$/.test(e) ? e : undefined;
}

/** The model a hosted Codex thread runs on when nobody picked one (the owner, 2026-11-13: GPT-6.1 Sol). */
export const HOSTED_CODEX_DEFAULT_MODEL = 'gpt-6.1-sol';

/**
 * The default model of a Codex thread on a hosted box: GPT-6.1 Sol, not Codex's own default.
 * DISPATCH_CODEX_DEFAULT_MODEL sets another; an OFF value leaves Codex's own default. A local install: none.
 * The image's /etc/codex/config.toml names the same model, for a `codex` an agent starts itself.
 */
export function hostedCodexDefaultModel(env: NodeJS.ProcessEnv = process.env, hosted: boolean = isHostedBox(env)): string | undefined {
  if (!hosted) return undefined;
  const raw = env.DISPATCH_CODEX_DEFAULT_MODEL;
  const m = raw === undefined ? HOSTED_CODEX_DEFAULT_MODEL : raw.trim();
  if (OFF.test(m)) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/.test(m) ? m : HOSTED_CODEX_DEFAULT_MODEL;
}
