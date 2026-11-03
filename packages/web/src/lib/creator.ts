/** Who created an integration or a schedule (core auth/creator.ts). null = a row from before the record existed. */
export type Creator =
  | { kind: 'owner' | 'local' | 'tailscale' | 'chat' }
  | { kind: 'thread' | 'shell'; terminalId: string; name: string | null };

/** A short plain label for the Settings and Agents screens. */
export function describeCreator(c: Creator | null | undefined): string {
  if (!c) return 'Unknown';
  switch (c.kind) {
    case 'owner': return 'Owner (signed in)';
    case 'local': return 'Local, no sign-in';
    case 'tailscale': return 'Tailscale, no sign-in';
    case 'chat': return 'Chat';
    case 'thread':
    case 'shell': {
      const who = c.name || `thread ${c.terminalId.slice(0, 8)}`;
      return c.kind === 'shell' ? `Shell in ${who}` : `Thread: ${who}`;
    }
  }
}
