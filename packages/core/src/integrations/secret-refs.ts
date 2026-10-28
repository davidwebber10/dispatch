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

/**
 * A header or env name that holds a credential: Authorization / Cookie, or a name that ends in
 * token, secret, password, credential, apikey, or `_key` / `-key` (`API_KEY`, `x-api-key`, `accessKey`).
 * Singular suffix match only, so `TOKEN_URL`, `KEYBOARD`, `MONKEY`, `MAX_TOKENS` and `GOOGLE_APPLICATION_CREDENTIALS` (a file path) are not caught.
 */
export function looksSecretName(name: string): boolean {
  const n = name.trim();
  if (/^(proxy-)?authorization$|^(set-)?cookie$/i.test(n)) return true;
  if (/(token|secret|password|passwd|credential|apikey)$/i.test(n)) return true;
  return /(^|[_-])key$/i.test(n) || /[a-z]Key$/.test(n);
}

/**
 * The first header or env entry that looks secret but holds a typed-in literal (no `${NAME}` ref),
 * as a message for the user; null when every such entry is empty or a reference. A literal ends up in
 * argv (a remote header), in 0644 config files and in the database, so it is refused up front.
 */
export function literalSecretProblem(i: { headers?: unknown; env?: unknown }): string | null {
  const check = (kind: 'header' | 'env', bag: unknown): string | null => {
    if (!bag || typeof bag !== 'object') return null;
    for (const [k, v] of Object.entries(bag as Record<string, unknown>)) {
      const value = typeof v === 'string' ? v : v == null ? '' : String(v);
      // A number or a flag (MAX_TOKEN=4096) is a setting, not a credential.
      if (!value.trim() || !looksSecretName(k) || refsIn(value).length || /^(\d+(\.\d+)?|true|false)$/i.test(value.trim())) continue;
      const example = kind === 'header' && /authorization/i.test(k) ? 'Bearer ${MY_API_TOKEN}' : '${MY_API_TOKEN}';
      return `${kind} "${k}" looks like a secret. Do not type its value here: store the value in Secrets and write a reference such as ${example}`;
    }
    return null;
  };
  return check('header', i.headers) ?? check('env', i.env);
}
