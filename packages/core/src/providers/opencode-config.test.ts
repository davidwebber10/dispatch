import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeOpencodeConfig } from './opencode-config.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-'));
const read = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;

describe('writeOpencodeConfig', () => {
  const mcpServers = { dispatch: { command: 'node', args: ['agency.js'] } };

  it('writes the model and the MCP servers for a tool-capable model', () => {
    const cfg = read(writeOpencodeConfig({ dir: tmp(), model: 'openrouter/~z-ai/glm-latest', mcpServers }));
    expect(cfg.model).toBe('openrouter/~z-ai/glm-latest');
    expect(cfg.tools).toBeUndefined();
    expect((cfg.mcp as Record<string, unknown>).dispatch).toMatchObject({ type: 'local', command: ['node', 'agency.js'] });
  });

  it('turns every tool off and drops the MCP servers for a chat-only model', () => {
    const cfg = read(writeOpencodeConfig({ dir: tmp(), model: 'openrouter/cognitivecomputations/dolphin-mistral-24b-venice-edition', mcpServers, toolsDisabled: true }));
    // Verified live: this exact block is what lets OpenRouter route a model with no
    // tool-capable endpoint — any tool left on gets "No endpoints found that support tool use".
    expect(cfg.tools).toEqual({ '*': false });
    expect(cfg.mcp).toBeUndefined();
    expect(cfg.model).toBe('openrouter/cognitivecomputations/dolphin-mistral-24b-venice-edition');
  });
});
