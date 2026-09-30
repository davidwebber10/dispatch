/**
 * `${NAME}` secret references in an integration.
 *
 * A ref may sit in a remote header VALUE or an env VALUE — the two places whose resolved
 * form reaches only the MCP server's process env (see launcher.ts). Never in args or the
 * url: a resolved arg lands in argv, which every process on the box can read.
 */

const REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The names a template references, in first-seen order, each once. */
export function refsIn(template: string): string[] {
  const names: string[] = [];
  for (const m of template.matchAll(REF_RE)) if (!names.includes(m[1])) names.push(m[1]);
  return names;
}

export interface RefSource {
  type: 'stdio' | 'remote';
  headers?: Record<string, string>;
  env?: Record<string, string>;
  // Accepted so a whole integration can be passed in; deliberately never read.
  args?: string[];
  url?: string | null;
}

/** Every secret an integration references (header values for remote, env values for both). */
export function findSecretRefs(i: RefSource): string[] {
  const values = [...(i.type === 'remote' ? Object.values(i.headers ?? {}) : []), ...Object.values(i.env ?? {})];
  const names: string[] = [];
  for (const v of values) for (const n of refsIn(String(v))) if (!names.includes(n)) names.push(n);
  return names;
}

/** Replace each ref that has a value; a ref without one stays literal. */
export function substituteSecretRefs(template: string, values: Record<string, string>): string {
  return template.replace(REF_RE, (whole, name: string) => (Object.hasOwn(values, name) ? values[name] : whole));
}
