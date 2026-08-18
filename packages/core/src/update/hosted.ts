/**
 * Updating a HOSTED box.
 *
 * On a local install, `update` means: git pull, rebuild, restart the launchd job.
 * None of those three exist on a hosted box, and the failure is not cosmetic:
 *
 *   • There is no git checkout. The image is built with `COPY . .` and
 *     `.dockerignore` excludes `.git`, so `git -C /app status` fails outright —
 *     which is the "not a git repository" error a box reports today.
 *   • There is no launchd. The daemon is PID 1 in the container.
 *   • **The filesystem is ephemeral.** This is the one that matters. `/app` lives
 *     in the container layer, not on the EFS home, so even if a pull and rebuild
 *     succeeded, the next task restart would silently revert it. An update that
 *     quietly undoes itself is worse than one that refuses.
 *
 * So on a box, update means something different in kind: roll onto a newer IMAGE.
 * The box asks OS, OS re-registers the task definition against the newest image
 * and forces a new deployment, and ECS replaces the container. That persists
 * across restarts, keeps every box on a known build rather than 52 independently
 * drifted checkouts, and is reversible — the previous task definition still
 * points at the previous digest.
 *
 * The box cannot do any of that itself: it holds no AWS credentials, by design
 * (its task role grants nothing). Asking the control plane is not a workaround,
 * it is the only correct direction for the request.
 */

export interface HostedTarget {
  baseUrl: string;
  boxToken: string;
}

/**
 * The OS control plane to ask, or null when this is an ordinary local daemon.
 *
 * Both variables are injected by the provisioner at task-definition time, so
 * their presence IS the definition of "hosted". A local install has neither, and
 * therefore keeps the git path unchanged — this file adds a branch, it does not
 * replace the existing behaviour.
 */
export function hostedTarget(env: NodeJS.ProcessEnv = process.env): HostedTarget | null {
  const baseUrl = env.OS_BASE_URL?.replace(/\/+$/, '');
  const boxToken = env.OS_BOX_TOKEN;
  if (!baseUrl || !boxToken) return null;
  return { baseUrl, boxToken };
}

export interface HostedUpdateState {
  available: boolean;
  /** Version of the newest built image, when one is newer than what is running. */
  version: string | null;
  currentVersion: string;
  /** Set when OS could not answer — shown to the user rather than swallowed. */
  error?: string;
}

export interface HostedFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function askOs(
  target: HostedTarget,
  path: string,
  init: RequestInit,
  opts: HostedFetchOptions = {},
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  // A hung control plane must not hang the update UI. The caller renders the
  // timeout as a reason, which is far better than a spinner that never resolves.
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    return await fetchImpl(`${target.baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-dispatch-box-token': target.boxToken,
        ...(process.env.DISPATCH_OWNER_EMAIL
          ? { 'x-dispatch-owner': process.env.DISPATCH_OWNER_EMAIL }
          : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Is a newer image built and waiting? Answered by OS, which owns the registry. */
export async function checkHostedUpdate(
  target: HostedTarget,
  currentVersion: string,
  opts: HostedFetchOptions = {},
): Promise<HostedUpdateState> {
  try {
    const res = await askOs(
      target,
      `/api/dispatch/box/update?current=${encodeURIComponent(currentVersion)}`,
      { method: 'GET' },
      opts,
    );
    if (!res.ok) {
      return { available: false, version: null, currentVersion, error: `OS answered ${res.status}` };
    }
    const body = (await res.json()) as { available?: boolean; version?: string | null };
    return {
      available: body.available === true,
      version: body.version ?? null,
      currentVersion,
    };
  } catch (err: any) {
    // "We could not ask" is not "there is no update". Saying so is the difference
    // between a user who waits and a user who reports a broken button.
    return {
      available: false,
      version: null,
      currentVersion,
      error: `could not reach OS: ${err?.message ?? String(err)}`,
    };
  }
}

export interface HostedApplyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Ask OS to roll this box onto the newest image.
 *
 * Returns as soon as OS accepts. The rollover itself takes a minute or two and
 * ends with this process being replaced, so there is nothing further to report
 * from in here — the client sees the socket drop and reconnects to the new task.
 */
export async function applyHostedUpdate(
  target: HostedTarget,
  opts: HostedFetchOptions = {},
): Promise<HostedApplyResult> {
  try {
    const res = await askOs(target, '/api/dispatch/box/rebuild', { method: 'POST', body: '{}' }, opts);
    if (res.ok) return { ok: true };
    let detail = `OS answered ${res.status}`;
    try {
      const body = (await res.json()) as { detail?: string; reason?: string };
      if (body?.detail || body?.reason) detail = String(body.detail ?? body.reason);
    } catch {
      /* a non-JSON error body is still worth reporting by status alone */
    }
    return { ok: false, reason: detail };
  } catch (err: any) {
    return { ok: false, reason: `could not reach OS: ${err?.message ?? String(err)}` };
  }
}
