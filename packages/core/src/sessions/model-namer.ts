import { cleanName } from './thread-namer.js';

/**
 * Model-generated thread titles via OpenRouter.
 *
 * z-ai/glm-5-turbo won a 6-model GLM shoot-out (2026-08-15) for this exact call:
 * consistently 1.0-1.4s with no latency spikes (glm-4.7 and glm-4.7-flash both
 * showed 8-10s outliers) and 100% compliance with the 3-5 word instruction
 * (glm-5 and glm-4.7-flash drifted to 6-7 words). Title quality was on par with
 * the flagship glm-5.2 at roughly half the latency. Cost per title is ~$0.0002.
 */
export const NAMER_MODEL = 'z-ai/glm-5-turbo';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 8_000;
// Plenty for "what is this thread about" — and a hard cap on spend per title.
const MAX_PROMPT_CHARS = 2_000;

/**
 * Ask the model for a 3-5 word thread title. Returns null on ANY failure —
 * missing/invalid key, HTTP error, timeout, empty completion — because every
 * caller has a perfectly good fallback (the prompt-prefix name) and a naming
 * nicety must never surface an error. `reasoning: {enabled: false}` is load-
 * bearing: GLM models default to thinking mode and will happily burn the whole
 * max_tokens budget on reasoning tokens, returning a null completion.
 */
export async function generateThreadName(apiKey: string, conversationText: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: NAMER_MODEL,
        max_tokens: 24,
        temperature: 0.3,
        reasoning: { enabled: false },
        messages: [
          { role: 'system', content: 'You title chat threads. Reply with ONLY a concise 3-5 word title for the conversation. No quotes, no trailing punctuation, no explanations.' },
          { role: 'user', content: conversationText.slice(0, MAX_PROMPT_CHARS) },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const raw = data?.choices?.[0]?.message?.content;
    if (typeof raw !== 'string') return null;
    // Belt-and-braces despite the prompt: strip wrapping quotes + trailing
    // punctuation, then cleanName normalizes whitespace and caps at 48 chars.
    return cleanName(raw.replace(/^["'‘’“”]+|["'‘’“”.]+$/g, ''));
  } catch {
    return null; // timeout, network, JSON parse — all fall back silently
  } finally {
    clearTimeout(timer);
  }
}
