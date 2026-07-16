/** Parse the thread deep-link URL the SW opens on notification tap. Matches the
 *  mobile nav scheme (/p/<sessionId>/t/<terminalId>) so mobile restores it natively;
 *  the desktop shell parses it with this and converts it to an open-thread intent. */
export function parseThreadPath(path: string): { sessionId: string; terminalId: string } | null {
  const m = path.match(/^\/p\/([^/]+)\/t\/([^/]+)$/);
  return m ? { sessionId: m[1], terminalId: m[2] } : null;
}
