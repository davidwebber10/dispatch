#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDopplerClient } from './doppler-client.js';
import { registerTools } from './tools.js';

const TOKEN = process.env.DOPPLER_TOKEN;
const PROJECT = process.env.DOPPLER_PROJECT;
const CONFIG = process.env.DOPPLER_CONFIG;
const READ_ONLY = process.env.DOPPLER_READ_ONLY === '1';

if (!TOKEN) {
  console.error('DOPPLER_TOKEN is required');
  process.exit(1);
}

const server = new McpServer({ name: 'doppler', version: '0.1.0' });
registerTools(server, createDopplerClient(TOKEN), { project: PROJECT, config: CONFIG, readOnly: READ_ONLY });

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('doppler mcp server running on stdio (readOnly=' + READ_ONLY + ')');
