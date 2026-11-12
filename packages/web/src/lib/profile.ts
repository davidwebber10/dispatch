// The profile feature map: which features each profile shows (Dispatch hosted in Polywood OS, 2026-11).
//
// ONE place decides what a person sees. Every gate in the web page reads this map through `can()` or
// `useFeature()`; no component compares the profile itself. The map hides, it never removes: the
// code paths stay, and the developer profile shows everything, exactly as before.
//
// The daemon enforces the part that matters for safety (core/src/profile/business-gate.ts): a hidden
// terminal is also a refused terminal.
//
// === AGENT NOTES ===
// - To show or hide a feature for business people, change its `business` value below. That is all.
// - To gate a new feature: add a key here (with `note`), then call `useFeature('<key>')` (in a
//   component) or `can('<key>')` (anywhere else) at the place that shows it. Hide the ENTRY POINT
//   (the button, the menu row, the palette command); do not delete code.
// - `developer` must stay true for every key: profile.test.ts checks it.
// - Keyboard shortcuts and command-palette entries that lead to a hidden feature are gated too.
import { hostContext, realHostContext, type Profile } from './hostContext';

export interface FeatureRule {
  business: boolean;
  developer: true;
  /** False: hidden on a hosted workspace in EVERY profile (the feature cannot work there). */
  hosted?: false;
}

// What each key covers is the comment on its line (comments, not strings: this module is in the first load).
const show = (): FeatureRule => ({ business: true, developer: true });
const hide = (): FeatureRule => ({ business: false, developer: true });
/** Hidden for business people, and on a hosted workspace for everyone (it needs the person's own computer). */
const localOnly = (): FeatureRule => ({ business: false, developer: true, hosted: false });

/** EDIT HERE. The proposal for business people (to be revised after the design session). */
export const FEATURES = {
  // ── Shown to a business person ──────────────────────────────────────────────
  'threads.chat': show(), // Projects, threads list, and chat (Pretty) threads for every harness that supports them
  'tabs.notes': show(), // Notes tabs
  'tabs.files': show(), // File tabs, the Files shelf and the file browser (read, upload, download)
  previews: show(), // Previews / Inbox
  'needs-you': show(), // The "Needs you" list
  automations: show(), // Automations and schedules
  endless: show(), // Chat ("Endless"): it runs without a terminal
  accounts: show(), // Settings > Accounts: sign in to Claude and Codex
  approvals: show(), // The approvals UI
  attachments: show(), // Attachments and voice input in the composer
  update: show(), // The update prompt (plain wording when hosted)
  'tabs.grid': show(), // Tabs across the top; drag to merge them into a grid (Multi-pane tabs, "Operator")
  'settings.appearance': show(), // Settings > Appearance (only the OS themes when hosted)
  'settings.notifications': show(), // Settings > Notifications
  'settings.about': show(), // Settings > About & updates

  // ── Hidden from a business person ───────────────────────────────────────────
  'threads.cli': hide(), // CLI/terminal mode, the Pretty <-> CLI switch, the CLI sign-in shell
  'threads.shell': hide(), // Shell threads
  'threads.browser': hide(), // Browser threads
  'threads.git': hide(), // Worktree, git and branch options (new-thread worktree, branch a thread)
  'review.diff': hide(), // Diff review
  'control-plane': hide(), // Control Plane: overseer, coordinator, ledger, recaps, decision cards
  missions: hide(), // Missions and agent types
  analytics: hide(), // Analytics
  'settings.agents': hide(), // Settings > Agents (harness defaults)
  'settings.usage': hide(), // Settings > Usage limits
  'settings.integrations': hide(), // Settings > Integrations (add an MCP server)
  'settings.secrets': hide(), // Settings > Secrets (Doppler)
  'settings.tools': hide(), // Settings > Tools
  'settings.dictation': hide(), // Settings > Dictation: its API key lives in Doppler, which a business workspace has not
  'settings.devices': localOnly(), // Settings > Devices & access (pairing): a hosted workspace has no device list
  'settings.servers': localOnly(), // Settings > Servers and the server switcher: other Dispatch machines
  'about.report': hide(), // Settings > About: "Report a problem" on GitHub
  setup: localOnly(), // The setup wizard (install CLIs, Tailscale, Doppler). A hosted developer gets only the account step
  'settings.plugins': hide(), // Settings > Plugins, plugin settings sections and plugin screens in the rail
  'settings.skills': hide(), // Settings > Skills marketplace
  'settings.telemetry': hide(), // Telemetry settings
  'model-picker': hide(), // The model picker (the default model applies)
  'effort-picker': hide(), // The effort picker
  'tool-json': hide(), // Raw tool-call JSON expanders (the one-line tool row stays)
  'projects.path': hide(), // The folder path picker of New Project (a hosted developer keeps it under Advanced)
  'details.machine': hide(), // Details pane: thread ID, folder, branch, PID, tool servers, provider
  'settings.editor': hide(), // Settings > Appearance > "Open docs in" (an editor on the computer)
  'themes.all': hide(), // Every theme; a business person picks only OS light, OS dark or System
} as const satisfies Record<string, FeatureRule>;

export type Feature = keyof typeof FEATURES;

/** May `profile` see `feature`? An unknown key is shown (fail open to the old UI, never to a blank screen). */
export function featureFor(feature: Feature, profile: Profile): boolean {
  const rule = FEATURES[feature] as FeatureRule | undefined;
  if (!rule) return true;
  return rule[profile];
}

/** May this page's person see `feature`? For code outside React. A `hosted: false` feature is hidden on every hosted workspace. */
export function can(feature: Feature): boolean {
  const rule = FEATURES[feature] as FeatureRule | undefined;
  if (rule?.hosted === false && realHostContext().hosted) return false;
  return featureFor(feature, hostContext().profile);
}

/** The same, for a component. The profile does not change while the page runs, so this needs no store. */
export function useFeature(feature: Feature): boolean {
  return can(feature);
}

/** True for the business profile. Prefer `can()`; this is for wording, not for gates. */
export function isBusiness(): boolean {
  return hostContext().profile === 'business';
}
