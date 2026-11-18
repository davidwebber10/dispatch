// packages/core/src/os/harness-policy.ts
// Does THIS machine carry the strict harness policy of the hosted image (docker/hosted/policy)?
//
// The policy file is root-owned and part of the image, so the daemon cannot change it; it can only
// read it. A hosted box under the BUSINESS profile starts a thread only when the file says that no
// harness can skip approvals: a developer image (or an image with no policy) must never run a
// business person's threads, whatever the platform says the profile is.
import fs from 'node:fs';

export const CLAUDE_MANAGED_SETTINGS = '/etc/claude-code/managed-settings.json';

let known = false;

/** True when Claude Code's managed settings turn the bypass of approvals off. A missing or unreadable file: false. */
export function harnessPolicyIsStrict(file: string = process.env.DISPATCH_CLAUDE_MANAGED_SETTINGS || CLAUDE_MANAGED_SETTINGS): boolean {
  // The file never changes while the container lives (root-owned, read-only to the daemon): a yes is kept.
  if (known && file === CLAUDE_MANAGED_SETTINGS) return true;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { permissions?: { disableBypassPermissionsMode?: unknown } };
    const strict = parsed?.permissions?.disableBypassPermissionsMode === 'disable';
    if (strict && file === CLAUDE_MANAGED_SETTINGS) known = true;
    return strict;
  } catch {
    return false;
  }
}

export const NOT_A_BUSINESS_IMAGE = 'This workspace cannot run a thread yet: it has to move to the standard image first. Ask your administrator.';
