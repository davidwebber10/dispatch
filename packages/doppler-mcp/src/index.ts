#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDopplerClient } from './doppler-client.js';
import { resolveConnection } from './connection.js';
import { registerTools } from './tools.js';

// `--secrets-dir <dir>`: read the connection Dispatch saved there. No flag: DOPPLER_* variables.
const conn = resolveConnection(process.argv.slice(2), process.env);
if (!conn.ok) {
  // A fixed line. Never the token itself.
  console.error(conn.error);
  process.exit(1);
}

const server = new McpServer({ name: 'doppler', version: '0.1.0' });
registerTools(server, createDopplerClient(conn.token), { project: conn.project, config: conn.config, readOnly: conn.readOnly });

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('doppler mcp server running on stdio (readOnly=' + conn.readOnly + ')');
