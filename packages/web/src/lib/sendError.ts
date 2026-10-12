/**
 * The text for a failed message send: the fixed lead, plus the server's reason when the API
 * client carried one (`… failed: 400 — <reason>`, see api/client.ts). The bare lead hid why a
 * thread could not start (#76).
 */
export function sendFailureText(err: unknown): string {
  const msg = err instanceof Error ? err.message : '';
  const i = msg.indexOf(' — ');
  const reason = i >= 0 ? msg.slice(i + 3).trim() : '';
  return reason ? `Failed to send message: ${reason}` : 'Failed to send message';
}
