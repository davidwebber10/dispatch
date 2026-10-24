/**
 * The summary engine switch (Task 1, probe b). claude at high is the controller's ruling (high
 * median 5,940 ms, user chose subscription billing); switch to 'openrouter' here if summaries
 * are too slow. Switching is this one line.
 */
import type { IStructuredManager } from '../structured/manager.js';
import type { Summarizer, Usage } from './summarizer.js';
import type { KeyRegistry } from '../auth/principals.js';
import { ClaudeSummarizer } from './summarizer-claude.js';
import { OpenRouterSummarizer } from './summarizer-openrouter.js';

export type SummaryEngine = 'claude' | 'openrouter';
export const SUMMARY_ENGINE = 'claude' as SummaryEngine;

export function createSummarizer(d: {
  manager: IStructuredManager;
  chatDir: string;
  mcpConfigPath: string;
  openRouterKey: () => Promise<string | null>;
  onUsage?: (u: Usage) => void;
  keys?: () => KeyRegistry | undefined;
}): Summarizer {
  return SUMMARY_ENGINE === 'openrouter'
    ? new OpenRouterSummarizer({ apiKey: d.openRouterKey })
    : new ClaudeSummarizer({ manager: d.manager, chatDir: d.chatDir, mcpConfigPath: d.mcpConfigPath, onUsage: d.onUsage, keys: d.keys });
}
