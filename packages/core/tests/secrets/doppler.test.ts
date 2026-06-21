import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DopplerClient } from '../../src/secrets/doppler.js';

/**
 * Builds a fetch Response-like stub. The client only reads `status` and `text()`,
 * so we keep the shape minimal and JSON-encode the payload.
 */
function fakeFetch(status: number, payload: unknown) {
  const ok = status >= 200 && status < 300;
  return vi.fn().mockResolvedValue({
    ok,
    status,
    text: async () => JSON.stringify(payload),
  });
}

const TOKEN = 'dp.st.test-token';

describe('DopplerClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('verify', () => {
    it('returns true on a 2xx response', async () => {
      const fetchMock = fakeFetch(200, { projects: [] });
      vi.stubGlobal('fetch', fetchMock);

      const client = new DopplerClient(TOKEN);
      await expect(client.verify()).resolves.toBe(true);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.doppler.com/v3/projects');
      expect(init.method).toBe('GET');
      expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(init.headers.Accept).toBe('application/json');
    });

    it('returns false on a 401 response', async () => {
      vi.stubGlobal('fetch', fakeFetch(401, { messages: ['Invalid token'] }));

      const client = new DopplerClient(TOKEN);
      await expect(client.verify()).resolves.toBe(false);
    });
  });

  describe('listProjects', () => {
    it('parses body.projects into {id,slug,name}[]', async () => {
      const fetchMock = fakeFetch(200, {
        projects: [
          { id: 'p1', slug: 'app', name: 'App', extra: 'ignored' },
          { id: 'p2', slug: 'api', name: 'API' },
        ],
      });
      vi.stubGlobal('fetch', fetchMock);

      const client = new DopplerClient(TOKEN);
      const projects = await client.listProjects();

      expect(projects).toEqual([
        { id: 'p1', slug: 'app', name: 'App' },
        { id: 'p2', slug: 'api', name: 'API' },
      ]);
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.doppler.com/v3/projects');
    });
  });

  describe('listConfigs', () => {
    it('builds the ?project= query and parses configs', async () => {
      const fetchMock = fakeFetch(200, {
        configs: [
          { name: 'dev', environment: 'dev', extra: 'ignored' },
          { name: 'prd', environment: 'prd' },
        ],
      });
      vi.stubGlobal('fetch', fetchMock);

      const client = new DopplerClient(TOKEN);
      const configs = await client.listConfigs('app');

      expect(configs).toEqual([
        { name: 'dev', environment: 'dev' },
        { name: 'prd', environment: 'prd' },
      ]);
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.doppler.com/v3/configs?project=app');
    });
  });

  describe('listSecrets', () => {
    it('converts the {NAME:{computed}} map to {name,value}[]', async () => {
      const fetchMock = fakeFetch(200, {
        secrets: {
          API_KEY: { raw: 'raw-key', computed: 'computed-key' },
          ONLY_RAW: { raw: 'raw-only' },
          EMPTY: {},
        },
      });
      vi.stubGlobal('fetch', fetchMock);

      const client = new DopplerClient(TOKEN);
      const secrets = await client.listSecrets('app', 'dev');

      expect(secrets).toEqual([
        { name: 'API_KEY', value: 'computed-key' },
        { name: 'ONLY_RAW', value: 'raw-only' },
        { name: 'EMPTY', value: '' },
      ]);
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.doppler.com/v3/configs/config/secrets?project=app&config=dev',
      );
    });
  });

  describe('getSecret', () => {
    it('returns value.computed', async () => {
      const fetchMock = fakeFetch(200, {
        name: 'API_KEY',
        value: { raw: 'raw-key', computed: 'computed-key' },
      });
      vi.stubGlobal('fetch', fetchMock);

      const client = new DopplerClient(TOKEN);
      const value = await client.getSecret('app', 'dev', 'API_KEY');

      expect(value).toBe('computed-key');
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.doppler.com/v3/configs/config/secret?project=app&config=dev&name=API_KEY',
      );
    });

    it('falls back to value.raw, then null', async () => {
      vi.stubGlobal('fetch', fakeFetch(200, { value: { raw: 'raw-key' } }));
      let client = new DopplerClient(TOKEN);
      await expect(client.getSecret('app', 'dev', 'API_KEY')).resolves.toBe('raw-key');

      vi.stubGlobal('fetch', fakeFetch(200, { value: {} }));
      client = new DopplerClient(TOKEN);
      await expect(client.getSecret('app', 'dev', 'API_KEY')).resolves.toBeNull();
    });
  });

  describe('setSecret', () => {
    it('POSTs the right URL and JSON body with the Bearer header', async () => {
      const fetchMock = fakeFetch(200, { secrets: {} });
      vi.stubGlobal('fetch', fetchMock);

      const client = new DopplerClient(TOKEN);
      await client.setSecret('app', 'dev', 'API_KEY', 'secret-value');

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.doppler.com/v3/configs/config/secrets');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(init.body)).toEqual({
        project: 'app',
        config: 'dev',
        secrets: { API_KEY: 'secret-value' },
      });
    });
  });

  describe('deleteSecret', () => {
    it('POSTs secrets:{NAME:null}', async () => {
      const fetchMock = fakeFetch(200, { secrets: {} });
      vi.stubGlobal('fetch', fetchMock);

      const client = new DopplerClient(TOKEN);
      await client.deleteSecret('app', 'dev', 'API_KEY');

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.doppler.com/v3/configs/config/secrets');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        project: 'app',
        config: 'dev',
        secrets: { API_KEY: null },
      });
    });
  });

  describe('error handling', () => {
    it('throws Doppler <status>: <text> on a non-2xx response', async () => {
      vi.stubGlobal('fetch', fakeFetch(500, { messages: ['boom'] }));

      const client = new DopplerClient(TOKEN);
      await expect(client.listProjects()).rejects.toThrow(
        `Doppler 500: ${JSON.stringify({ messages: ['boom'] })}`,
      );
    });
  });
});
