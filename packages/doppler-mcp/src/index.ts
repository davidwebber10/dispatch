#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const TOKEN = process.env.DOPPLER_TOKEN;
const PROJECT = process.env.DOPPLER_PROJECT;
const CONFIG = process.env.DOPPLER_CONFIG;
const READ_ONLY = process.env.DOPPLER_READ_ONLY === '1';

if (!TOKEN) {
  console.error('DOPPLER_TOKEN is required');
  process.exit(1);
}

async function doppler(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`https://api.doppler.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Doppler ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

const fail = (e: unknown) => ({
  content: [{ type: 'text' as const, text: String(e instanceof Error ? e.message : e) }],
  isError: true,
});

const qs = (
  p: string | undefined,
  c: string | undefined,
  extra: Record<string, string> = {},
) =>
  new URLSearchParams({
    project: p ?? PROJECT ?? '',
    config: c ?? CONFIG ?? '',
    ...extra,
  }).toString();

const server = new McpServer({ name: 'doppler', version: '0.1.0' });

server.registerTool(
  'doppler_list_secrets',
  {
    description: 'List all secrets in a Doppler config.',
    inputSchema: {
      project: z.string().optional(),
      config: z.string().optional(),
    },
  },
  async ({ project, config }) => {
    try {
      return ok(await doppler(`/v3/configs/config/secrets?${qs(project, config)}`));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'doppler_get_secret',
  {
    description: 'Get a single secret by name from a Doppler config.',
    inputSchema: {
      name: z.string(),
      project: z.string().optional(),
      config: z.string().optional(),
    },
  },
  async ({ name, project, config }) => {
    try {
      return ok(await doppler(`/v3/configs/config/secret?${qs(project, config, { name })}`));
    } catch (e) {
      return fail(e);
    }
  },
);

if (!READ_ONLY) {
  server.registerTool(
    'doppler_set_secret',
    {
      description: 'Set (create or update) a secret in a Doppler config.',
      inputSchema: {
        name: z.string(),
        value: z.string(),
        project: z.string().optional(),
        config: z.string().optional(),
      },
    },
    async ({ name, value, project, config }) => {
      try {
        return ok(
          await doppler('/v3/configs/config/secrets', {
            method: 'POST',
            body: JSON.stringify({
              project: project ?? PROJECT,
              config: config ?? CONFIG,
              secrets: { [name]: value },
            }),
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'doppler_delete_secret',
    {
      description: 'Delete a secret from a Doppler config.',
      inputSchema: {
        name: z.string(),
        project: z.string().optional(),
        config: z.string().optional(),
      },
    },
    async ({ name, project, config }) => {
      try {
        return ok(
          await doppler('/v3/configs/config/secrets', {
            method: 'POST',
            body: JSON.stringify({
              project: project ?? PROJECT,
              config: config ?? CONFIG,
              secrets: { [name]: null },
            }),
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('doppler mcp server running on stdio (readOnly=' + READ_ONLY + ')');
