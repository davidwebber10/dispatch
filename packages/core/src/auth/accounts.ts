// packages/core/src/auth/accounts.ts
// Several accounts per harness (docs/superpowers/specs/2026-11-06-multi-account-design.md).
//
// `cli` is always an account for Claude and for Codex: the CLI's own login on this machine (the
// keychain or credentials file; ~/.codex). An added Claude account is a saved token from the
// headless login (`claude setup-token`); an added Codex account is a folder of its own under
// `<dataDir>/codex-accounts/<id>` that holds that login's auth.json and sessions, used as
// CODEX_HOME. The file `<dataDir>/accounts.json` (0600) holds them and the per-harness default.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { UsageAccess } from '../limits/gauge.js';

export const CLI_ACCOUNT_ID = 'cli';
export const ACCOUNT_PROVIDERS = ['claude', 'codex'] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

export interface ClaudeAccount { id: string; label: string; email?: string; accountUuid?: string; plan?: string; token: string; addedAt: string }
export interface CodexAccount { id: string; label: string; email?: string; dir: string; addedAt: string }
/**
 * The wire shape: never the token. `usageAccess` (W1-H, Claude only): what the sign-in can do for the
 * usage figures, from the gauge's last read; absent until a read has said.
 */
export interface PublicAccount { id: string; label: string; email?: string; plan?: string; isCli: boolean; addedAt: string | null; usageAccess?: UsageAccess }
export interface AccountsView { claude: PublicAccount[]; codex: PublicAccount[]; defaults: Record<AccountProvider, string> }

interface FileShape { claude: ClaudeAccount[]; codex: CodexAccount[]; defaults: Partial<Record<AccountProvider, string>>; cliLabels?: Partial<Record<AccountProvider, string>> }

/** What a Codex login file says about its account: the email and plan inside its id token. */
export interface CodexIdentity { email?: string; plan?: string }

/**
 * Read the account behind a Codex `auth.json` (2026-11-06): the `tokens.id_token` is a JWT whose
 * payload carries `email` and, under the OpenAI claim, `chatgpt_plan_type`. Nothing is verified
 * (the CLI did that); this only names the account. Null when the file has no id token.
 */
export function parseCodexAuth(text: string): CodexIdentity | null {
  try {
    const j = JSON.parse(text);
    const idToken = j?.tokens?.id_token;
    if (typeof idToken !== 'string') return null;
    const part = idToken.split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const plan = payload?.['https://api.openai.com/auth']?.chatgpt_plan_type;
    return {
      ...(typeof payload?.email === 'string' ? { email: payload.email } : {}),
      ...(typeof plan === 'string' && plan ? { plan: plan.charAt(0).toUpperCase() + plan.slice(1) } : {}),
    };
  } catch { return null; }
}

const CLI_LABEL: Record<AccountProvider, string> = { claude: 'CLI login (this computer)', codex: 'CLI login (this computer)' };
/** The provider id of a terminal type, or null for a harness without accounts. */
export function accountProviderOf(type: string): AccountProvider | null {
  return type === 'claude-code' ? 'claude' : type === 'codex' ? 'codex' : null;
}

export class AccountsStore {
  private readonly file: string;
  private data: FileShape;
  private listeners: (() => void)[] = [];
  private usageAccessOf: ((accountId: string) => UsageAccess | null) | null = null;
  private checkListeners: ((accountId: string) => void)[] = [];

  constructor(private readonly dataDir: string) {
    this.file = path.join(dataDir, 'accounts.json');
    this.data = this.load();
  }

  onChange(fn: () => void): void { this.listeners.push(fn); }
  /** Where the view learns what each Claude sign-in can do for the usage figures (the gauge). */
  setUsageAccessSource(fn: (accountId: string) => UsageAccess | null): void { this.usageAccessOf = fn; }
  /** What one Claude account's sign-in can do for the usage figures, or null when not known. */
  claudeUsageAccess(accountId: string): UsageAccess | null {
    try { return this.usageAccessOf?.(accountId) ?? null; } catch { return null; }
  }
  /** "Check again" (W1-H): the owner asks for a Claude account's usage read now. The gauge listens. */
  onCheckUsage(fn: (accountId: string) => void): void { this.checkListeners.push(fn); }
  checkUsage(accountId: string): void { for (const fn of this.checkListeners) { try { fn(accountId); } catch { /* a listener's own problem */ } } }
  private changed(): void { for (const fn of this.listeners) { try { fn(); } catch { /* a listener's own problem */ } } }

  private load(): FileShape {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        claude: Array.isArray(j?.claude) ? j.claude.filter((a: any) => a && typeof a.id === 'string' && typeof a.token === 'string') : [],
        codex: Array.isArray(j?.codex) ? j.codex.filter((a: any) => a && typeof a.id === 'string' && typeof a.dir === 'string') : [],
        defaults: j?.defaults && typeof j.defaults === 'object' ? j.defaults : {},
        ...(j?.cliLabels && typeof j.cliLabels === 'object' ? { cliLabels: j.cliLabels } : {}),
      };
    } catch { return { claude: [], codex: [], defaults: {} }; }
  }

  private save(): void {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
    fs.renameSync(tmp, this.file);
    this.changed();
  }

  /**
   * The single saved login of earlier versions (`<dataDir>/claude-oauth-token`) becomes the
   * account `saved` and the Claude default, once. The file stays: older code paths read it.
   */
  migrateSavedClaudeToken(token: string | null): void {
    if (!token || this.data.claude.some((a) => a.token === token)) return;
    if (this.data.claude.some((a) => a.id === 'saved')) return;
    this.data.claude.push({ id: 'saved', label: 'Dispatch login', token, addedAt: new Date().toISOString() });
    if (!this.data.defaults.claude) this.data.defaults.claude = 'saved';
    this.save();
  }

  view(): AccountsView {
    const pub = (a: { id: string; label: string; email?: string; plan?: string; addedAt: string }): PublicAccount =>
      ({ id: a.id, label: a.label, ...(a.email ? { email: a.email } : {}), ...(a.plan ? { plan: a.plan } : {}), isCli: false, addedAt: a.addedAt });
    const cli = (p: AccountProvider): PublicAccount => ({ id: CLI_ACCOUNT_ID, label: this.data.cliLabels?.[p] || CLI_LABEL[p], isCli: true, addedAt: null });
    const withAccess = (a: PublicAccount): PublicAccount => { const u = this.claudeUsageAccess(a.id); return u ? { ...a, usageAccess: { state: u.state, lastOkAt: u.lastOkAt } } : a; };
    return {
      claude: [cli('claude'), ...this.data.claude.map(pub)].map(withAccess),
      codex: [cli('codex'), ...this.data.codex.map(pub)],
      defaults: { claude: this.defaultId('claude'), codex: this.defaultId('codex') },
    };
  }

  /** Every account of a provider, `cli` first: for the usage gauge. */
  list(provider: AccountProvider): { id: string; label: string }[] {
    return this.view()[provider].map((a) => ({ id: a.id, label: a.label }));
  }

  has(provider: AccountProvider, id: string): boolean {
    return id === CLI_ACCOUNT_ID || (provider === 'claude' ? this.data.claude : this.data.codex).some((a) => a.id === id);
  }

  defaultId(provider: AccountProvider): string {
    const d = this.data.defaults[provider];
    return d && this.has(provider, d) ? d : CLI_ACCOUNT_ID;
  }

  setDefault(provider: AccountProvider, id: string): void {
    if (!this.has(provider, id)) throw new Error('unknown account');
    this.data.defaults[provider] = id;
    this.save();
  }

  addClaude(input: { token: string; label?: string; email?: string; accountUuid?: string; plan?: string }): ClaudeAccount {
    const existing = this.data.claude.find((a) => a.token === input.token || (input.accountUuid && a.accountUuid === input.accountUuid));
    if (existing) {
      // The same account again: a fresh token replaces the old one; the label and profile refresh.
      Object.assign(existing, { token: input.token, ...(input.label ? { label: input.label } : {}), ...(input.email ? { email: input.email } : {}), ...(input.accountUuid ? { accountUuid: input.accountUuid } : {}), ...(input.plan ? { plan: input.plan } : {}) });
      this.save();
      return existing;
    }
    const a: ClaudeAccount = { id: randomUUID().slice(0, 8), label: input.label?.trim() || input.email || 'Claude account', token: input.token, addedAt: new Date().toISOString(), ...(input.email ? { email: input.email } : {}), ...(input.accountUuid ? { accountUuid: input.accountUuid } : {}), ...(input.plan ? { plan: input.plan } : {}) };
    this.data.claude.push(a);
    this.save();
    return a;
  }

  /**
   * "Sign in again" for one saved account (W1-H): the new token replaces the old one in place, so
   * the account keeps its id, its name and its pinned threads. False when the id is not a saved account.
   */
  replaceClaudeToken(id: string, token: string, profile: { email?: string; accountUuid?: string; plan?: string } = {}): ClaudeAccount | null {
    const a = this.data.claude.find((x) => x.id === id);
    if (!a || !token) return null;
    Object.assign(a, { token }, Object.fromEntries(Object.entries(profile).filter(([, v]) => typeof v === 'string' && v)));
    this.save();
    return a;
  }

  /** Fill in what the profile call learned. */
  updateClaude(id: string, patch: { email?: string; accountUuid?: string; plan?: string; label?: string }): void {
    const a = this.data.claude.find((x) => x.id === id);
    if (!a) return;
    Object.assign(a, Object.fromEntries(Object.entries(patch).filter(([, v]) => typeof v === 'string' && v)));
    this.save();
  }

  /** A new Codex account: its own folder, to be signed in by a "Sign in — Codex" thread under that CODEX_HOME. */
  addCodex(label: string): CodexAccount {
    const id = randomUUID().slice(0, 8);
    const dir = path.join(this.dataDir, 'codex-accounts', id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const a: CodexAccount = { id, label: label.trim() || 'Codex account', dir, addedAt: new Date().toISOString() };
    this.data.codex.push(a);
    this.save();
    return a;
  }

  updateCodex(id: string, patch: { email?: string; label?: string }): void {
    const a = this.data.codex.find((x) => x.id === id);
    if (!a) return;
    Object.assign(a, Object.fromEntries(Object.entries(patch).filter(([, v]) => typeof v === 'string' && v)));
    this.save();
  }

  /** Name an account yourself (2026-11-06). The CLI login takes a name too; empty restores its stock name. */
  rename(provider: AccountProvider, id: string, label: string): void {
    const name = label.trim();
    if (id === CLI_ACCOUNT_ID) {
      this.data.cliLabels = { ...this.data.cliLabels, [provider]: name };
      if (!name) delete this.data.cliLabels[provider];
      this.save();
      return;
    }
    const a = (provider === 'claude' ? this.data.claude : this.data.codex).find((x) => x.id === id);
    if (!a) throw new Error('unknown account');
    if (!name) throw new Error('a name is required');
    a.label = name;
    this.save();
  }

  /** The folder a Codex account's login lives in: its own for an added account, the CLI's for `cli`. */
  codexHomeOrCli(id: string): string {
    return id === CLI_ACCOUNT_ID ? (process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) : this.codexHome(id) ?? '';
  }

  /** Who a Codex account is, from its auth.json (see parseCodexAuth); null when not signed in. */
  codexIdentity(id: string): CodexIdentity | null {
    const dir = this.codexHomeOrCli(id);
    if (!dir) return null;
    try { return parseCodexAuth(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')); } catch { return null; }
  }

  remove(provider: AccountProvider, id: string): boolean {
    if (id === CLI_ACCOUNT_ID) throw new Error('the CLI login cannot be removed here');
    const list = provider === 'claude' ? this.data.claude : this.data.codex;
    const i = list.findIndex((a) => a.id === id);
    if (i < 0) return false;
    const [gone] = list.splice(i, 1);
    if (provider === 'codex') { try { fs.rmSync((gone as CodexAccount).dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    if (this.data.defaults[provider] === id) delete this.data.defaults[provider];
    this.save();
    return true;
  }

  claudeToken(id: string): string | null {
    return this.data.claude.find((a) => a.id === id)?.token ?? null;
  }

  /** A short stamp of a saved account's token (a hash, never the token): it changes when the token does. Null for `cli` and unknown ids. */
  claudeTokenStamp(id: string): string | null {
    const token = this.claudeToken(id);
    return token ? createHash('sha256').update(token).digest('hex').slice(0, 12) : null;
  }

  codexHome(id: string): string | null {
    return this.data.codex.find((a) => a.id === id)?.dir ?? null;
  }

  /** Whether a Codex account's folder holds a login yet. */
  codexSignedIn(id: string): boolean {
    const dir = this.codexHome(id);
    return !!dir && fs.existsSync(path.join(dir, 'auth.json'));
  }

  /**
   * The env overlay for one thread (the PTY path and the structured path alike), from its
   * `config.accountId`, else the provider's default. Claude `cli` sets the token variable EMPTY,
   * which makes the CLI use its own login even when the daemon's default env holds a saved token.
   */
  spawnEnv(type: string, config: Record<string, unknown> | null | undefined): Record<string, string> {
    const provider = accountProviderOf(type) ?? (config?.signIn === 'codex' ? 'codex' : config?.signIn === 'claude' ? 'claude' : null);
    if (!provider) return {};
    const wanted = typeof config?.accountId === 'string' && config.accountId ? config.accountId : this.defaultId(provider);
    const id = this.has(provider, wanted) ? wanted : this.defaultId(provider);
    if (provider === 'claude') {
      if (id === CLI_ACCOUNT_ID) return { CLAUDE_CODE_OAUTH_TOKEN: '' };
      const token = this.claudeToken(id);
      return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
    }
    if (id === CLI_ACCOUNT_ID) return {};
    const dir = this.codexHome(id);
    return dir ? { CODEX_HOME: dir } : {};
  }
}

/**
 * Keep the token a Claude login captured (POST /api/accounts/claude/login, the headless
 * `claude setup-token` flow). The profile is read FIRST, so a login to a Claude account Dispatch
 * already has (signing a signed-out account in again from a thread's "Sign in") replaces that
 * account's token — addClaude matches it by its account id — instead of adding a duplicate the
 * thread is not pinned to. Without a profile (offline) the token is added under the label.
 *
 * `accountId` (W1-H, "Sign in again" on one account): that saved account's token is replaced in
 * place, whatever the profile says. A `claude setup-token` token cannot read the profile (403 for
 * scope), so such an account holds no Claude account id to match by. An id that is gone, or `cli`,
 * falls back to the match above.
 */
export async function adoptClaudeLoginToken(
  accounts: AccountsStore,
  token: string,
  label: string,
  fetchProfile: (token: string) => Promise<{ email?: string; accountUuid?: string; plan?: string } | null>,
  accountId?: string,
): Promise<ClaudeAccount> {
  const p = await fetchProfile(token).catch(() => null);
  const replaced = accountId ? accounts.replaceClaudeToken(accountId, token, p ?? {}) : null;
  if (replaced) return replaced;
  return accounts.addClaude({ token, label: label.trim() || p?.email || '', ...(p?.email ? { email: p.email } : {}), ...(p?.accountUuid ? { accountUuid: p.accountUuid } : {}), ...(p?.plan ? { plan: p.plan } : {}) });
}
