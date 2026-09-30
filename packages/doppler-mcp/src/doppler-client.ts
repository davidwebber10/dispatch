export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** An error whose message is built here from a status code and fixed text, never from upstream text. */
export class DopplerError extends Error {}

export interface DopplerClient {
  /** GET a Doppler endpoint and parse its JSON body. */
  read(path: string): Promise<unknown>;
  /** POST a change to the config's secrets. */
  write(body: object): Promise<void>;
}

/**
 * The Doppler REST calls behind the MCP tools. A tool result, error or not, lands in the
 * agent's transcript, and any text Doppler sends can carry secret values: a write answers
 * with every secret in the config, and an error's `messages` can quote a value. So every
 * error here is a DopplerError built from the status and a fixed category — Doppler's
 * text is never read on an error, a JSON.parse message (which quotes its input) is never
 * used, and a write's success body is not read at all.
 */
export function createDopplerClient(token: string, fetchFn: FetchLike = fetch): DopplerClient {
  async function send(path: string, init: RequestInit): Promise<Response> {
    const res = await fetchFn(`https://api.doppler.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      await discard(res);
      throw new DopplerError(`Doppler ${res.status}: ${category(res.status)}`);
    }
    return res;
  }

  return {
    async read(path) {
      const res = await send(path, {});
      const text = await res.text();
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        throw new DopplerError(`Doppler ${res.status}: the response is not valid JSON`);
      }
    },
    async write(body) {
      await discard(await send('/v3/configs/config/secrets', { method: 'POST', body: JSON.stringify(body) }));
    },
  };
}

/** Drop a body unread. */
async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

function category(status: number): string {
  if (status === 401 || status === 403) return 'the token was rejected';
  if (status === 404) return 'not found';
  if (status === 429) return 'rate limited';
  if (status >= 500) return 'the service is unavailable';
  if (status >= 400) return 'Doppler rejected the request';
  return 'unexpected response';
}

/**
 * The token as it goes into the Authorization header, or null when it cannot: a CR, LF,
 * or NUL inside it makes fetch throw an error that quotes the whole header value. The
 * surrounding whitespace is trimmed, as fetch itself does for a header value.
 */
export function usableToken(raw: string): string | null {
  const token = raw.trim();
  return token && !/[\r\n\0]/.test(token) ? token : null;
}
