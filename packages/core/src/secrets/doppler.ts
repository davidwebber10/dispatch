/**
 * Minimal REST client for the Doppler API (https://docs.doppler.com/reference).
 *
 * Wraps the subset of endpoints Dispatch needs to read and write secrets.
 * Secret values are never logged.
 */

const DOPPLER_BASE_URL = 'https://api.doppler.com';

export interface DopplerProject {
  id: string;
  slug: string;
  name: string;
}

export interface DopplerConfig {
  name: string;
  environment: string;
}

export interface DopplerSecret {
  name: string;
  value: string;
}

export class DopplerClient {
  constructor(private token: string) {}

  /**
   * Returns true when the token can list projects, false on auth failures.
   */
  async verify(): Promise<boolean> {
    try {
      await this.request('GET', '/v3/projects');
      return true;
    } catch {
      // Any error (including 401/403) means the token can't be used.
      return false;
    }
  }

  async listProjects(): Promise<DopplerProject[]> {
    const body = await this.request('GET', '/v3/projects');
    const projects = (body?.projects ?? []) as Array<{ id: string; slug: string; name: string }>;
    return projects.map((p) => ({ id: p.id, slug: p.slug, name: p.name }));
  }

  async listConfigs(project: string): Promise<DopplerConfig[]> {
    const query = new URLSearchParams({ project });
    const body = await this.request('GET', `/v3/configs?${query.toString()}`);
    const configs = (body?.configs ?? []) as Array<{ name: string; environment: string }>;
    return configs.map((c) => ({ name: c.name, environment: c.environment }));
  }

  async listSecrets(project: string, config: string): Promise<DopplerSecret[]> {
    const query = new URLSearchParams({ project, config });
    const body = await this.request('GET', `/v3/configs/config/secrets?${query.toString()}`);
    const secrets = (body?.secrets ?? {}) as Record<string, { raw?: string; computed?: string }>;
    return Object.entries(secrets).map(([name, v]) => ({
      name,
      value: v.computed ?? v.raw ?? '',
    }));
  }

  async getSecret(project: string, config: string, name: string): Promise<string | null> {
    const query = new URLSearchParams({ project, config, name });
    const body = await this.request('GET', `/v3/configs/config/secret?${query.toString()}`);
    return body?.value?.computed ?? body?.value?.raw ?? null;
  }

  async setSecret(project: string, config: string, name: string, value: string): Promise<void> {
    await this.request('POST', '/v3/configs/config/secrets', {
      project,
      config,
      secrets: { [name]: value },
    });
  }

  async deleteSecret(project: string, config: string, name: string): Promise<void> {
    // A null value deletes the secret; this is more reliable than the DELETE verb.
    await this.request('POST', '/v3/configs/config/secrets', {
      project,
      config,
      secrets: { [name]: null },
    });
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`${DOPPLER_BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Doppler ${res.status}: ${text}`);
    }

    return text ? JSON.parse(text) : null;
  }
}
