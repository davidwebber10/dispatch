// packages/core/src/os/hosted-claude-policy.ts
// The Claude Code managed settings files of the hosted image, as the image build writes them.
//
// docker/hosted/policy/claude-managed-settings*.json hold every key that does not come from
// elsewhere. The build stage of the image runs `hosted-claude-policy-cli.js`, which adds the
// `spinnerVerbs` of the POLYWOOD word set (read from the web client's word-set file, never copied)
// and writes the result that the runtime stage installs under /etc/claude-code. Pure here; the
// file work is in the CLI.
import type { SpinnerVerbs } from '../settings/harness-settings.js';

/** The policy files this step completes (the Codex file is copied as it is). */
export const CLAUDE_POLICY_FILE = /^claude-managed-settings(\.[a-z]+)?\.json$/;

/** One managed settings document with the hosted spinner words, in mode `replace`. */
export function withHostedSpinner(base: Record<string, unknown>, verbs: SpinnerVerbs): Record<string, unknown> {
  if (verbs.mode !== 'replace' || verbs.verbs.length === 0) throw new Error('the hosted spinner words must be a non-empty replace set');
  return { ...base, spinnerVerbs: { mode: verbs.mode, verbs: [...verbs.verbs] } };
}

/** The managed documents of every Claude policy file in `files` (name -> parsed JSON), completed. */
export function completeClaudePolicies(files: Record<string, Record<string, unknown>>, verbs: SpinnerVerbs): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, doc] of Object.entries(files)) if (CLAUDE_POLICY_FILE.test(name)) out[name] = withHostedSpinner(doc, verbs);
  return out;
}
