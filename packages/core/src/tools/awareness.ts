import type { ToolStatus } from './types.js';

export function awarenessNote(statuses: ToolStatus[]): string {
  const installed = statuses.filter((s) => s.installed);
  if (!installed.length) return '';
  const flag = (s: ToolStatus) => (s.authState === 'ok' ? ''
    : s.authState === 'unknown' ? ' (sign-in not verified)'
      : ' (not authenticated — may fail until its credentials are set)');
  const lines = installed.map((s) => `- \`${s.name}\` — ${s.description}${flag(s)}`);
  return `## CLI tools available via Dispatch\n\nThese CLIs are installed and on your PATH; use them directly via shell commands when helpful.\n\n${lines.join('\n')}`;
}
