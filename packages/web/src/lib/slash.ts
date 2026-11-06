// The "/" command registry is shared with the daemon (core/src/providers/slash-commands.ts), so the
// menu and the daemon's checks cannot drift apart. Same pattern as lib/harnesses.ts.
export {
  parseSlash, slashCommandsFor, resolveModelArg, resolveEffortArg, EFFORT_LEVELS,
} from '../../../core/src/providers/slash-commands';
export type { SlashCommand, SlashSurface, SlashHarness, ParsedSlash } from '../../../core/src/providers/slash-commands';
