import { HARNESSES } from '../../lib/harnesses';
/** "Claude", "Codex", "OpenCode": the catalog label without " Code" / " CLI". */
export function harnessShort(type: string): string {
  const label = HARNESSES.find((h) => h.type === type)?.label ?? type;
  return label.replace(/\s+(Code|CLI)$/i, '');
}
