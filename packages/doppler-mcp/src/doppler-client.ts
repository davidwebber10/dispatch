export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface DopplerClient {
  /** GET a Doppler endpoint and parse its JSON body. */
  read(path: string): Promise<unknown>;
  /** POST a change to the config's secrets. `redact` is removed from any error text. */
  write(body: object, redact?: string): Promise<void>;
}

/**
 * The Doppler REST calls behind the MCP tools. A tool result, error or not, lands in the
 * agent's transcript, and Doppler's bodies can carry secret values: a write answers with
 * every secret in the config. So an error here is built from the status and, at most,
 * Doppler's own `messages` — never the raw body, and never a JSON.parse error message,
 * which quotes its input. A write's success body is not read at all.
 */
export function createDopplerClient(token: string, fetchFn: FetchLike = fetch): DopplerClient {
  async function send(path: string, init: RequestInit, redact?: string): Promise<Response> {
    const res = await fetchFn(`https://api.doppler.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    if (!res.ok) throw new Error(await errorMessage(res, redact));
    return res;
  }

  return {
    async read(path) {
      const res = await send(path, {});
      const text = await res.text();
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Doppler ${res.status}: the response is not valid JSON`);
      }
    },
    async write(body, redact) {
      const res = await send('/v3/configs/config/secrets', { method: 'POST', body: JSON.stringify(body) }, redact);
      await res.body?.cancel().catch(() => {}); // unread: it holds every value in the config
    },
  };
}

async function errorMessage(res: Response, redact?: string): Promise<string> {
  let messages: string[] = [];
  try {
    const body = JSON.parse(await res.text());
    if (Array.isArray(body?.messages)) messages = body.messages.filter((m: unknown) => typeof m === 'string');
  } catch { /* not JSON: the status alone */ }
  if (redact) messages = messages.map((m) => m.split(redact).join('[redacted]'));
  return messages.length ? `Doppler ${res.status}: ${messages.join('; ')}` : `Doppler ${res.status}`;
}
