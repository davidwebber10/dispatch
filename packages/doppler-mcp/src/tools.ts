import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DopplerError, type DopplerClient } from './doppler-client.js';
import { secretNames } from './secret-names.js';
import { writeConfirmation } from './write-confirmation.js';

export interface ToolOptions {
  /** Used when a tool call omits project/config (DOPPLER_PROJECT / DOPPLER_CONFIG). */
  project?: string;
  config?: string;
  /** DOPPLER_READ_ONLY=1: the write tools are not registered. */
  readOnly: boolean;
}

const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

// Only a DopplerError's text is ours. Any other exception (fetch, a body read) can quote the
// token or a body — Node's fetch puts an invalid header value in its message — so it gets a
// fixed text instead.
const fail = (e: unknown) => ({
  content: [{
    type: 'text' as const,
    text: e instanceof DopplerError ? e.message : 'Doppler request failed (network or client error)',
  }],
  isError: true,
});

/** The doppler_* tools. Kept apart from index.ts so tests can drive them with a fake fetch. */
export function registerTools(server: McpServer, doppler: DopplerClient, opts: ToolOptions): void {
  const qs = (
    p: string | undefined,
    c: string | undefined,
    extra: Record<string, string> = {},
  ) =>
    new URLSearchParams({
      project: p ?? opts.project ?? '',
      config: c ?? opts.config ?? '',
      ...extra,
    }).toString();

  server.registerTool(
    'doppler_list_secrets',
    {
      description:
        'List the names of all secrets in a Doppler config. Values are not returned; ' +
        'use doppler_get_secret to read one value.',
      inputSchema: {
        project: z.string().optional(),
        config: z.string().optional(),
      },
    },
    async ({ project, config }) => {
      try {
        const body = await doppler.read(`/v3/configs/config/secrets/names?${qs(project, config)}`);
        return ok({
          project: project ?? opts.project,
          config: config ?? opts.config,
          names: secretNames(body),
        });
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
        return ok(await doppler.read(`/v3/configs/config/secret?${qs(project, config, { name })}`));
      } catch (e) {
        return fail(e);
      }
    },
  );

  if (opts.readOnly) return;

  server.registerTool(
    'doppler_set_secret',
    {
      description:
        'Set (create or update) a secret in a Doppler config. The value is not echoed back; ' +
        'the result only confirms which secret was updated.',
      inputSchema: {
        name: z.string(),
        value: z.string(),
        project: z.string().optional(),
        config: z.string().optional(),
      },
    },
    async ({ name, value, project, config }) => {
      const target = { project: project ?? opts.project, config: config ?? opts.config, name };
      try {
        await doppler.write({ project: target.project, config: target.config, secrets: { [name]: value } });
        return ok(writeConfirmation('updated', target));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'doppler_delete_secret',
    {
      description:
        'Delete a secret from a Doppler config. No values are echoed back; ' +
        'the result only confirms which secret was deleted.',
      inputSchema: {
        name: z.string(),
        project: z.string().optional(),
        config: z.string().optional(),
      },
    },
    async ({ name, project, config }) => {
      const target = { project: project ?? opts.project, config: config ?? opts.config, name };
      try {
        await doppler.write({ project: target.project, config: target.config, secrets: { [name]: null } });
        return ok(writeConfirmation('deleted', target));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
