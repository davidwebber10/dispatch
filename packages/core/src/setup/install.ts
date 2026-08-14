// Unprefixed 'child_process', matching the rest of core — the `node:`-prefixed specifier
// resolves to a type here that is missing the EventEmitter surface (`.on`).
import { spawn, type ChildProcess } from 'child_process';
import { PROVIDER_NAMES, detectProvider, type ProviderName, type ProviderStatus } from './detect.js';

/**
 * The install command for each agent CLI, taken from that vendor's own documented
 * one-liner. These are CONSTANTS, looked up by a name that is checked against
 * PROVIDER_NAMES first — nothing a caller sends is ever interpolated into a shell string.
 */
export const INSTALL_COMMANDS: Record<ProviderName, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  grok: 'curl -fsSL https://x.ai/cli/install.sh | bash',
};

/** How each CLI is signed in afterwards. Installing never authenticates. */
export const LOGIN_COMMANDS: Record<ProviderName, string> = {
  claude: 'claude',
  codex: 'codex login',
  grok: 'grok login',
};

/** Grok downloads a ~130MB binary; a cold npm global install is slower than it looks. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/** Only the tail of the log comes back — enough to diagnose, small enough to ship. */
const MAX_OUTPUT_CHARS = 4000;

export interface InstallResult {
  ok: boolean;
  /** Tail of the combined stdout/stderr, for showing the user what happened. */
  output: string;
  /** Freshly re-detected status, so the caller never has to guess whether it worked. */
  status: ProviderStatus;
  /** The command to sign in, which the install itself does not do. */
  loginCommand: string;
}

export type ShellRunner = (command: string) => Promise<{ ok: boolean; output: string }>;

export function isProviderName(name: string): name is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(name);
}

function tail(s: string): string {
  return s.length <= MAX_OUTPUT_CHARS ? s : `…\n${s.slice(-MAX_OUTPUT_CHARS)}`;
}

/**
 * Default runner: a LOGIN shell, because these one-liners assume the user's own
 * environment. `npm` usually lives behind nvm, which only exists once the profile has
 * been sourced — the daemon's own inherited PATH is not enough.
 */
const defaultRun: ShellRunner = (command) =>
  new Promise((resolve) => {
    const child: ChildProcess = spawn('bash', ['-lc', command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const collect = (b: Buffer) => { out += b.toString(); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      out += '\n[dispatch] install timed out after 10 minutes.';
    }, INSTALL_TIMEOUT_MS);

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `${out}\n${String(err)}` });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out });
    });
  });

/**
 * Install one agent CLI, then re-detect it.
 *
 * `ok` reflects what is ON DISK afterwards, not merely the installer's exit code: an
 * installer can exit 0 having put the binary somewhere the daemon cannot see, and the
 * honest answer there is "not installed". The re-detection is the source of truth.
 */
export async function installProvider(name: ProviderName, run: ShellRunner = defaultRun): Promise<InstallResult> {
  const { ok: exitedClean, output } = await run(INSTALL_COMMANDS[name]);
  const status = await detectProvider(name);
  return {
    ok: exitedClean && status.installed,
    output: tail(output),
    status,
    loginCommand: LOGIN_COMMANDS[name],
  };
}
