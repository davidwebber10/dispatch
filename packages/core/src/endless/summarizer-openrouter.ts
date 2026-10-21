/**
 * Summarizer over OpenRouter chat completions: the fallback engine when `claude -p` is too
 * slow or too costly for summaries (Task 1, probe b). The conversation is kept per session
 * so the "Too long" follow-up sees the first reply.
 */
import type { Summarizer, SummarizerOpenOptions, SummarizerSession } from './summarizer.js';

export const OPENROUTER_SUMMARY_MODEL = 'anthropic/claude-haiku-5.5';
const URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface OpenRouterSummarizerOptions {
  apiKey: () => Promise<string | null>;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class OpenRouterSummarizer implements Summarizer {
  constructor(private readonly o: OpenRouterSummarizerOptions) {}

  open(opts: SummarizerOpenOptions): SummarizerSession {
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [{ role: 'system', content: opts.systemPrompt }];
    let first = false;
    const doFetch = this.o.fetchImpl ?? fetch;
    return {
      ask: async (text: string) => {
        const key = await this.o.apiKey();
        if (!key) throw new Error('no OpenRouter key is set');
        messages.push({ role: 'user', content: text });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.o.timeoutMs ?? 60_000);
        try {
          const res = await doFetch(URL, {
            method: 'POST',
            signal: controller.signal,
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: this.o.model ?? OPENROUTER_SUMMARY_MODEL, messages, max_tokens: 1024 }),
          });
          if (!first) { first = true; opts.onFirstToken(); }
          if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
          const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
          const reply = data.choices?.[0]?.message?.content;
          if (typeof reply !== 'string') throw new Error('OpenRouter returned no text');
          messages.push({ role: 'assistant', content: reply });
          return reply;
        } finally {
          clearTimeout(timer);
        }
      },
      close: () => {},
    };
  }
}
