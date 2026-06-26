import { execFileSync } from 'node:child_process';
import type { McpServerSpec } from '../mcp/injection.js';

export class IntegrationsService {
  // Detection result is cached for the daemon's lifetime: installing `executor`
  // after startup is not reflected until the daemon is restarted.
  private detected: { installed: boolean; version: string | null } | null = null;

  status(): { installed: boolean; version: string | null } {
    if (this.detected) return this.detected;
    try {
      const v = execFileSync('executor', ['--version'], { encoding: 'utf-8', timeout: 4000 }).trim();
      this.detected = { installed: true, version: v };
    } catch { this.detected = { installed: false, version: null }; }
    return this.detected;
  }

  getServerSpec(): McpServerSpec | null {
    if (!this.status().installed) return null;
    return { name: 'executor', command: 'executor', args: ['mcp', '--elicitation-mode', 'model'] };
  }

  getSystemPrompt(): string | null {
    if (!this.status().installed) return null;
    return 'An "executor" MCP server exposes your shared integration catalog (the same tools across Claude and Codex). Use its tools to call integrations, and its management tools to add a new integration when given API docs, a CLI, or an MCP. If Doppler is connected, store any credentials there.';
  }
}
