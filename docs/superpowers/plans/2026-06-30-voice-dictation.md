# Voice Dictation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add mobile-only voice dictation to Dispatch's LLM-chat inputs — a `+` flyout → live waveform → server-side transcription that fills the input for review.

**Architecture:** A new self-contained `transcription/` module in the daemon exposes `POST /api/transcribe`, which resolves a Doppler-referenced API key server-side and dispatches to a pluggable provider adapter. The web client adds a reusable `useDictation` hook + `DictationControl` (waveform/✓/✕) + `InputActionsMenu` (the `+` flyout), wired into the three mobile inputs (coordinator composer, agent chat, terminal bar). Provider/model/secret are chosen in a new Transcription settings section and sent with each upload as references.

**Tech Stack:** Node 18+ (global `fetch`/`FormData`/`Blob`), Express, `multer`, TypeScript, Vitest + supertest (core); React 18, Zustand, Vitest + Testing Library, Web Audio API + `MediaRecorder` (web).

## Global Constraints

- **Mobile only.** Every dictation affordance is gated behind the existing `useIsMobile()` hook; desktop composers are untouched.
- **Secrets never leave the daemon.** The web app stores/sends only the Doppler secret *name*; the value is resolved server-side via `SecretsService.getSecret(name)` and never returned to a client.
- **No transcoding.** No ffmpeg/native deps. All v1 providers accept both `audio/webm` (Opus) and `audio/mp4` (AAC) natively.
- **Fill, never submit.** Transcribed text is appended to the input's draft; the user triggers send. Nothing is written directly to a PTY.
- **v1 providers:** OpenAI, Groq (default), Deepgram, ElevenLabs, AssemblyAI. Google + Azure appear in the catalog as `coming-soon` (no adapter).
- **Default provider/model:** `groq` / `whisper-large-v3-turbo`.
- **Node global APIs:** use global `fetch`, `FormData`, `Blob` (Node 18+ / undici) — do not add `node-fetch` or `form-data`.
- **Upload cap:** 25 MB (`multer` `limits.fileSize`).

---

## File Structure

**Create (core):**
- `packages/core/src/transcription/types.ts` — shared interfaces.
- `packages/core/src/transcription/openai-compatible.ts` — OpenAI + Groq adapter.
- `packages/core/src/transcription/deepgram.ts` — Deepgram adapter.
- `packages/core/src/transcription/elevenlabs.ts` — ElevenLabs adapter.
- `packages/core/src/transcription/assemblyai.ts` — AssemblyAI adapter.
- `packages/core/src/transcription/registry.ts` — provider-id → entry map.
- `packages/core/src/transcription/service.ts` — orchestration.
- `packages/core/src/routes/transcribe.ts` — the route.
- Tests: `packages/core/src/transcription/*.test.ts`, `packages/core/src/routes/transcribe.test.ts`.

**Modify (core):**
- `packages/core/src/secrets/service.ts` — add `getSecret(name)`.
- `packages/core/src/server.ts` — mount the router (two builders).

**Create (web):**
- `packages/web/src/lib/transcription-providers.ts` — catalog.
- `packages/web/src/hooks/useDictation.ts` — recording state machine.
- `packages/web/src/components/dictation/DictationControl.tsx` — waveform UI.
- `packages/web/src/components/dictation/InputActionsMenu.tsx` — `+` flyout.
- `packages/web/src/components/settings/TranscriptionSection.tsx` — settings body.

**Modify (web):**
- `packages/web/src/stores/settings.ts` — stt fields.
- `packages/web/src/api/client.ts` — `transcribe()`.
- `packages/web/src/components/settings/SettingsModal.tsx` — tab.
- `packages/web/src/components/tabs/chat/ChatView.tsx` — wire.
- `packages/web/src/components/overseer/components/Composer.tsx` — wire.
- `packages/web/src/components/tabs/TerminalTab.tsx` — wire.

---

## Task 1: Transcription types + OpenAI-compatible adapter

**Files:**
- Create: `packages/core/src/transcription/types.ts`
- Create: `packages/core/src/transcription/openai-compatible.ts`
- Test: `packages/core/src/transcription/openai-compatible.test.ts`

**Interfaces:**
- Produces: `TranscribeInput { audio: Buffer; mimeType: string; language?: string; prompt?: string; keyterms?: string[] }`, `TranscribeResult { text: string; language?: string; raw: unknown }`, `SttAdapter { id: string; transcribe(model: string, apiKey: string, input: TranscribeInput): Promise<TranscribeResult> }`, `filenameForMime(mime: string): string`, `makeOpenAICompatibleAdapter(id: string, baseURL: string): SttAdapter`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/transcription/openai-compatible.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeOpenAICompatibleAdapter, filenameForMime } from './openai-compatible.js';

afterEach(() => vi.restoreAllMocks());

describe('filenameForMime', () => {
  it('maps common mimes to extensions', () => {
    expect(filenameForMime('audio/webm')).toBe('audio.webm');
    expect(filenameForMime('audio/mp4')).toBe('audio.mp4');
    expect(filenameForMime('audio/mpeg')).toBe('audio.mp3');
    expect(filenameForMime('weird/thing')).toBe('audio.webm');
  });
});

describe('openai-compatible adapter', () => {
  it('POSTs multipart to <baseURL>/audio/transcriptions with bearer auth and returns text', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ text: 'hello world', language: 'en' }), { status: 200 }),
    );
    const groq = makeOpenAICompatibleAdapter('groq', 'https://api.groq.com/openai/v1');
    const out = await groq.transcribe('whisper-large-v3-turbo', 'sk-test', {
      audio: Buffer.from('AUDIO'), mimeType: 'audio/mp4', prompt: 'coding',
    });
    expect(out.text).toBe('hello world');
    expect(out.language).toBe('en');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect((init as any).method).toBe('POST');
    expect((init as any).headers.Authorization).toBe('Bearer sk-test');
    expect((init as any).body).toBeInstanceOf(FormData);
    const form = (init as any).body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
    expect(form.get('prompt')).toBe('coding');
  });

  it('throws with status + body on non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad key', { status: 401 }));
    const openai = makeOpenAICompatibleAdapter('openai', 'https://api.openai.com/v1');
    await expect(openai.transcribe('whisper-1', 'x', { audio: Buffer.from('a'), mimeType: 'audio/webm' }))
      .rejects.toThrow(/openai 401: bad key/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/transcription/openai-compatible.test.ts`
Expected: FAIL — cannot resolve `./openai-compatible.js`.

- [ ] **Step 3: Write the types**

```ts
// packages/core/src/transcription/types.ts
export interface TranscribeInput {
  audio: Buffer;
  mimeType: string;      // e.g. 'audio/webm', 'audio/mp4'
  language?: string;     // ISO-639-1; undefined = auto-detect
  prompt?: string;       // free-form bias hint (OpenAI/Groq)
  keyterms?: string[];   // structured term list (Deepgram/ElevenLabs/AssemblyAI)
}

export interface TranscribeResult {
  text: string;
  language?: string;
  raw: unknown;          // provider response, for debugging
}

export interface SttAdapter {
  id: string;
  transcribe(model: string, apiKey: string, input: TranscribeInput): Promise<TranscribeResult>;
}
```

- [ ] **Step 4: Write the adapter**

```ts
// packages/core/src/transcription/openai-compatible.ts
import type { SttAdapter, TranscribeInput, TranscribeResult } from './types.js';

/** Map an audio mime to a filename+extension the Whisper endpoints sniff. */
export function filenameForMime(mime: string): string {
  const base = (mime || '').split(';')[0].trim();
  const ext: Record<string, string> = {
    'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
  };
  return `audio.${ext[base] ?? 'webm'}`;
}

/**
 * One adapter for every OpenAI-compatible /audio/transcriptions endpoint
 * (OpenAI, Groq, Azure-OpenAI-Whisper). Only baseURL/model/key differ.
 */
export function makeOpenAICompatibleAdapter(id: string, baseURL: string): SttAdapter {
  return {
    id,
    async transcribe(model: string, apiKey: string, input: TranscribeInput): Promise<TranscribeResult> {
      const form = new FormData();
      form.append('file', new Blob([input.audio], { type: input.mimeType }), filenameForMime(input.mimeType));
      form.append('model', model);
      if (input.language) form.append('language', input.language);
      if (input.prompt) form.append('prompt', input.prompt);
      const res = await fetch(`${baseURL}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!res.ok) throw new Error(`${id} ${res.status}: ${await res.text()}`);
      const j: any = await res.json();
      return { text: j?.text ?? '', language: j?.language, raw: j };
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter dispatch-server exec vitest run src/transcription/openai-compatible.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/transcription/types.ts packages/core/src/transcription/openai-compatible.ts packages/core/src/transcription/openai-compatible.test.ts
git commit -m "feat(core): transcription types + OpenAI-compatible STT adapter"
```

---

## Task 2: `SecretsService.getSecret(name)`

**Files:**
- Modify: `packages/core/src/secrets/service.ts` (add a method near `listSecrets`, ~line 146)
- Test: `packages/core/src/secrets/get-secret.test.ts`

**Interfaces:**
- Consumes: existing `SecretsService` constructor `(configDir, clientFactory?, dopplerMcpPath?)` and `DopplerClient.getSecret(project, config, name)`.
- Produces: `SecretsService.getSecret(name: string): Promise<string | null>` — throws `'Doppler is not connected'` if unconfigured.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/secrets/get-secret.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SecretsService } from './service.js';

function fakeClient() {
  return {
    verify: async () => true,
    listProjects: async () => [],
    listConfigs: async () => [],
    listSecrets: async () => [],
    getSecret: async (_p: string, _c: string, name: string) => (name === 'GROQ_API_KEY' ? 'gsk_live_123' : null),
    setSecret: async () => {},
    deleteSecret: async () => {},
  } as any;
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-sec-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

describe('SecretsService.getSecret', () => {
  it('resolves a secret value by name via the stored connection', async () => {
    const svc = new SecretsService(dir, () => fakeClient());
    await svc.setConnection({ token: 't', project: 'dispatch', config: 'prd', enabled: true, readOnly: true });
    expect(await svc.getSecret('GROQ_API_KEY')).toBe('gsk_live_123');
    expect(await svc.getSecret('MISSING')).toBeNull();
  });

  it('throws when Doppler is not connected', async () => {
    const svc = new SecretsService(dir, () => fakeClient());
    await expect(svc.getSecret('GROQ_API_KEY')).rejects.toThrow(/not connected/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/secrets/get-secret.test.ts`
Expected: FAIL — `svc.getSecret is not a function`.

- [ ] **Step 3: Add the method**

In `packages/core/src/secrets/service.ts`, immediately after the `listSecrets` method (ends ~line 146), add:

```ts
  /** Resolve a single secret's value by name (server-side only; never returned to clients). */
  async getSecret(name: string): Promise<string | null> {
    const c = this.read();
    if (!c.token || !c.project || !c.config) throw new Error('Doppler is not connected');
    return this.clientFactory(c.token).getSecret(c.project, c.config, name);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run src/secrets/get-secret.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/secrets/service.ts packages/core/src/secrets/get-secret.test.ts
git commit -m "feat(core): SecretsService.getSecret(name) for server-side key resolution"
```

---

## Task 3: Registry + TranscriptionService

**Files:**
- Create: `packages/core/src/transcription/registry.ts`
- Create: `packages/core/src/transcription/service.ts`
- Test: `packages/core/src/transcription/service.test.ts`

**Interfaces:**
- Consumes: `SttAdapter` (Task 1), `SecretsService.getSecret` (Task 2), `makeOpenAICompatibleAdapter` (Task 1).
- Produces: `ProviderEntry { id; label; models: string[]; adapter: SttAdapter | null; status: 'ready'|'coming-soon' }`, `REGISTRY: Record<string, ProviderEntry>`, `class TranscriptionService { constructor(secrets, registry?); transcribe(opts): Promise<TranscribeResult> }` where `opts = { provider; model; secretName; audio: Buffer; mimeType; language?; prompt? }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/transcription/service.test.ts
import { describe, it, expect, vi } from 'vitest';
import { TranscriptionService } from './service.js';
import type { ProviderEntry } from './registry.js';

function reg(overrides: Partial<Record<string, ProviderEntry>> = {}): Record<string, ProviderEntry> {
  return {
    groq: { id: 'groq', label: 'Groq', models: ['whisper-large-v3-turbo'], status: 'ready',
      adapter: { id: 'groq', transcribe: vi.fn().mockResolvedValue({ text: 'hi', raw: {} }) } },
    google: { id: 'google', label: 'Google', models: [], status: 'coming-soon', adapter: null },
    ...overrides,
  };
}

const secrets = (val: string | null) => ({ getSecret: vi.fn().mockResolvedValue(val) }) as any;

describe('TranscriptionService', () => {
  it('resolves the key and calls the provider adapter', async () => {
    const registry = reg();
    const svc = new TranscriptionService(secrets('gsk_x'), registry);
    const out = await svc.transcribe({ provider: 'groq', model: 'whisper-large-v3-turbo', secretName: 'GROQ_API_KEY', audio: Buffer.from('a'), mimeType: 'audio/webm', prompt: 'p' });
    expect(out.text).toBe('hi');
    expect(registry.groq.adapter!.transcribe).toHaveBeenCalledWith('whisper-large-v3-turbo', 'gsk_x', expect.objectContaining({ mimeType: 'audio/webm', prompt: 'p' }));
  });

  it('rejects unknown or coming-soon providers', async () => {
    const svc = new TranscriptionService(secrets('k'), reg());
    await expect(svc.transcribe({ provider: 'nope', model: 'm', secretName: 's', audio: Buffer.from('a'), mimeType: 'audio/webm' })).rejects.toThrow(/Unknown or unavailable/);
    await expect(svc.transcribe({ provider: 'google', model: 'm', secretName: 's', audio: Buffer.from('a'), mimeType: 'audio/webm' })).rejects.toThrow(/Unknown or unavailable/);
  });

  it('rejects when the secret is missing', async () => {
    const svc = new TranscriptionService(secrets(null), reg());
    await expect(svc.transcribe({ provider: 'groq', model: 'whisper-large-v3-turbo', secretName: 'X', audio: Buffer.from('a'), mimeType: 'audio/webm' })).rejects.toThrow(/Secret not found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/transcription/service.test.ts`
Expected: FAIL — cannot resolve `./service.js` / `./registry.js`.

- [ ] **Step 3: Write the registry**

```ts
// packages/core/src/transcription/registry.ts
import type { SttAdapter } from './types.js';
import { makeOpenAICompatibleAdapter } from './openai-compatible.js';

export interface ProviderEntry {
  id: string;
  label: string;
  models: string[];
  adapter: SttAdapter | null;      // null ⇒ coming-soon
  status: 'ready' | 'coming-soon';
}

const openai = makeOpenAICompatibleAdapter('openai', 'https://api.openai.com/v1');
const groq = makeOpenAICompatibleAdapter('groq', 'https://api.groq.com/openai/v1');

// Adapters added in later tasks are imported and slotted here as they land.
export const REGISTRY: Record<string, ProviderEntry> = {
  groq: { id: 'groq', label: 'Groq', models: ['whisper-large-v3-turbo', 'whisper-large-v3', 'distil-whisper-large-v3-en'], adapter: groq, status: 'ready' },
  openai: { id: 'openai', label: 'OpenAI', models: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'], adapter: openai, status: 'ready' },
  deepgram: { id: 'deepgram', label: 'Deepgram', models: ['nova-3', 'nova-2'], adapter: null, status: 'coming-soon' },
  elevenlabs: { id: 'elevenlabs', label: 'ElevenLabs', models: ['scribe_v2', 'scribe_v1'], adapter: null, status: 'coming-soon' },
  assemblyai: { id: 'assemblyai', label: 'AssemblyAI', models: ['universal-3-pro', 'universal-2'], adapter: null, status: 'coming-soon' },
  google: { id: 'google', label: 'Google Cloud STT', models: [], adapter: null, status: 'coming-soon' },
  azure: { id: 'azure', label: 'Azure AI Speech', models: [], adapter: null, status: 'coming-soon' },
};
```

> Deepgram/ElevenLabs/AssemblyAI are `coming-soon` here and flipped to `ready` with their real adapters in Tasks 5–7.

- [ ] **Step 4: Write the service**

```ts
// packages/core/src/transcription/service.ts
import type { TranscribeResult } from './types.js';
import { REGISTRY, type ProviderEntry } from './registry.js';

interface SecretsLike { getSecret(name: string): Promise<string | null>; }

export interface TranscribeOptions {
  provider: string;
  model: string;
  secretName: string;
  audio: Buffer;
  mimeType: string;
  language?: string;
  prompt?: string;
}

export class TranscriptionService {
  constructor(
    private readonly secrets: SecretsLike,
    private readonly registry: Record<string, ProviderEntry> = REGISTRY,
  ) {}

  async transcribe(opts: TranscribeOptions): Promise<TranscribeResult> {
    const entry = this.registry[opts.provider];
    if (!entry || entry.status !== 'ready' || !entry.adapter) {
      throw new Error(`Unknown or unavailable provider: ${opts.provider}`);
    }
    if (!opts.model) throw new Error('model is required');
    if (!opts.secretName) throw new Error('secretName is required');
    const key = await this.secrets.getSecret(opts.secretName);
    if (!key) throw new Error(`Secret not found: ${opts.secretName}`);
    return entry.adapter.transcribe(opts.model, key, {
      audio: opts.audio, mimeType: opts.mimeType, language: opts.language, prompt: opts.prompt,
    });
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter dispatch-server exec vitest run src/transcription/service.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/transcription/registry.ts packages/core/src/transcription/service.ts packages/core/src/transcription/service.test.ts
git commit -m "feat(core): transcription registry + service (key resolve + adapter dispatch)"
```

---

## Task 4: `POST /api/transcribe` route + server mount

**Files:**
- Create: `packages/core/src/routes/transcribe.ts`
- Modify: `packages/core/src/server.ts` (import + mount in both builders, near `createSecretsRouter` at lines ~162 and ~390)
- Test: `packages/core/src/routes/transcribe.test.ts`

**Interfaces:**
- Consumes: `TranscriptionService` (Task 3).
- Produces: `createTranscribeRouter(svc: TranscriptionService): Router`. Route `POST /api/transcribe`, multipart field `file`, body fields `provider`, `model`, `secretName`, `mimeType`, `language?`. Response `{ text, language? }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/routes/transcribe.test.ts
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTranscribeRouter } from './transcribe.js';

function app(svc: any) {
  const a = express();
  a.use('/api/transcribe', createTranscribeRouter(svc));
  return a;
}

describe('POST /api/transcribe', () => {
  it('returns text on success', async () => {
    const svc = { transcribe: async () => ({ text: 'hello', language: 'en', raw: {} }) };
    const res = await request(app(svc))
      .post('/api/transcribe')
      .field('provider', 'groq').field('model', 'whisper-large-v3-turbo')
      .field('secretName', 'GROQ_API_KEY').field('mimeType', 'audio/webm')
      .attach('file', Buffer.from('AUDIO'), { filename: 'clip.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: 'hello', language: 'en' });
  });

  it('400 when no file', async () => {
    const svc = { transcribe: async () => ({ text: '', raw: {} }) };
    const res = await request(app(svc)).post('/api/transcribe').field('provider', 'groq');
    expect(res.status).toBe(400);
  });

  it('400 for a client-side error (not connected / unknown provider)', async () => {
    const svc = { transcribe: async () => { throw new Error('Doppler is not connected'); } };
    const res = await request(app(svc)).post('/api/transcribe')
      .field('provider', 'groq').field('model', 'm').field('secretName', 's').field('mimeType', 'audio/webm')
      .attach('file', Buffer.from('a'), { filename: 'a.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not connected/);
  });

  it('502 for an upstream provider error', async () => {
    const svc = { transcribe: async () => { throw new Error('groq 500: boom'); } };
    const res = await request(app(svc)).post('/api/transcribe')
      .field('provider', 'groq').field('model', 'm').field('secretName', 's').field('mimeType', 'audio/webm')
      .attach('file', Buffer.from('a'), { filename: 'a.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(502);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/routes/transcribe.test.ts`
Expected: FAIL — cannot resolve `./transcribe.js`.

- [ ] **Step 3: Write the route**

```ts
// packages/core/src/routes/transcribe.ts
import { Router } from 'express';
import multer from 'multer';
import type { TranscriptionService } from '../transcription/service.js';

// v1-light priming: bias Whisper-family models toward technical spellings.
const DEFAULT_PROMPT = 'Technical dictation; may include file paths, camelCase identifiers, and CLI flags.';

export function createTranscribeRouter(svc: TranscriptionService): Router {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

  // POST /api/transcribe — multipart: file + provider/model/secretName/mimeType/language
  router.post('/', (req, res) => {
    upload.single('file')(req, res, async (err: any) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Audio too large (max 25MB)' });
      }
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No audio uploaded' });

      const b = req.body ?? {};
      const mimeType = (b.mimeType as string) || req.file.mimetype || 'audio/webm';
      try {
        const r = await svc.transcribe({
          provider: String(b.provider ?? ''),
          model: String(b.model ?? ''),
          secretName: String(b.secretName ?? ''),
          audio: req.file.buffer,
          mimeType,
          language: b.language ? String(b.language) : undefined,
          prompt: DEFAULT_PROMPT,
        });
        res.json({ text: r.text, language: r.language });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const client = /not connected|required|not found|unknown|unavailable/i.test(msg);
        res.status(client ? 400 : 502).json({ error: msg });
      }
    });
  });

  return router;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter dispatch-server exec vitest run src/routes/transcribe.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Mount the router in `server.ts`**

Add the imports near the other route imports (top of file, by `createSecretsRouter` at line 30):

```ts
import { createTranscribeRouter } from './routes/transcribe.js';
import { TranscriptionService } from './transcription/service.js';
```

In **both** server builders, immediately after the `app.use('/api/secrets', createSecretsRouter(secretsService));` line (line 162 and line 390), add:

```ts
  app.use('/api/transcribe', createTranscribeRouter(new TranscriptionService(secretsService)));
```

- [ ] **Step 6: Typecheck + verify the whole core suite**

Run: `pnpm --filter dispatch-server exec tsc --noEmit && pnpm --filter dispatch-server test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/routes/transcribe.ts packages/core/src/routes/transcribe.test.ts packages/core/src/server.ts
git commit -m "feat(core): POST /api/transcribe route + mount in server"
```

---

## Task 5: Deepgram adapter

**Files:**
- Create: `packages/core/src/transcription/deepgram.ts`
- Modify: `packages/core/src/transcription/registry.ts` (import + slot `adapter`, set `status: 'ready'`)
- Test: `packages/core/src/transcription/deepgram.test.ts`

**Interfaces:**
- Produces: `export const deepgramAdapter: SttAdapter`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/transcription/deepgram.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { deepgramAdapter } from './deepgram.js';

afterEach(() => vi.restoreAllMocks());

it('POSTs raw audio to /v1/listen with Token auth and parses nested transcript', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
    JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: 'nested text' }] }] } }), { status: 200 }));
  const out = await deepgramAdapter.transcribe('nova-3', 'dg_key', { audio: Buffer.from('A'), mimeType: 'audio/mp4', keyterms: ['Dispatch'] });
  expect(out.text).toBe('nested text');
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toContain('https://api.deepgram.com/v1/listen?');
  expect(String(url)).toContain('model=nova-3');
  expect(String(url)).toContain('keyterm=Dispatch');
  expect((init as any).headers.Authorization).toBe('Token dg_key');
  expect((init as any).headers['Content-Type']).toBe('audio/mp4');
});

it('throws on non-2xx', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 403 }));
  await expect(deepgramAdapter.transcribe('nova-3', 'x', { audio: Buffer.from('a'), mimeType: 'audio/webm' })).rejects.toThrow(/deepgram 403/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/transcription/deepgram.test.ts`
Expected: FAIL — cannot resolve `./deepgram.js`.

- [ ] **Step 3: Write the adapter**

```ts
// packages/core/src/transcription/deepgram.ts
import type { SttAdapter, TranscribeInput, TranscribeResult } from './types.js';

export const deepgramAdapter: SttAdapter = {
  id: 'deepgram',
  async transcribe(model: string, apiKey: string, input: TranscribeInput): Promise<TranscribeResult> {
    const params = new URLSearchParams({ model, smart_format: 'true' });
    if (input.language) params.set('language', input.language);
    for (const t of input.keyterms ?? []) params.append('keyterm', t); // Nova-3 term biasing
    const res = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': input.mimeType },
      body: input.audio,
    });
    if (!res.ok) throw new Error(`deepgram ${res.status}: ${await res.text()}`);
    const j: any = await res.json();
    const text = j?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
    return { text, raw: j };
  },
};
```

- [ ] **Step 4: Slot into the registry**

In `registry.ts`, add the import at top:

```ts
import { deepgramAdapter } from './deepgram.js';
```

Change the `deepgram` entry to:

```ts
  deepgram: { id: 'deepgram', label: 'Deepgram', models: ['nova-3', 'nova-2'], adapter: deepgramAdapter, status: 'ready' },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter dispatch-server exec vitest run src/transcription/deepgram.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/transcription/deepgram.ts packages/core/src/transcription/deepgram.test.ts packages/core/src/transcription/registry.ts
git commit -m "feat(core): Deepgram STT adapter"
```

---

## Task 6: ElevenLabs adapter

**Files:**
- Create: `packages/core/src/transcription/elevenlabs.ts`
- Modify: `packages/core/src/transcription/registry.ts`
- Test: `packages/core/src/transcription/elevenlabs.test.ts`

**Interfaces:**
- Produces: `export const elevenlabsAdapter: SttAdapter`. Uses `filenameForMime` from Task 1.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/transcription/elevenlabs.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { elevenlabsAdapter } from './elevenlabs.js';

afterEach(() => vi.restoreAllMocks());

it('POSTs multipart to /v1/speech-to-text with xi-api-key + model_id', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ text: 'scribe out', language_code: 'en' }), { status: 200 }));
  const out = await elevenlabsAdapter.transcribe('scribe_v2', 'xi_key', { audio: Buffer.from('A'), mimeType: 'audio/mp4', language: 'en' });
  expect(out.text).toBe('scribe out');
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toBe('https://api.elevenlabs.io/v1/speech-to-text');
  expect((init as any).headers['xi-api-key']).toBe('xi_key');
  const form = (init as any).body as FormData;
  expect(form.get('model_id')).toBe('scribe_v2');
  expect(form.get('language_code')).toBe('en');
});

it('throws on non-2xx', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad', { status: 401 }));
  await expect(elevenlabsAdapter.transcribe('scribe_v2', 'x', { audio: Buffer.from('a'), mimeType: 'audio/webm' })).rejects.toThrow(/elevenlabs 401/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/transcription/elevenlabs.test.ts`
Expected: FAIL — cannot resolve `./elevenlabs.js`.

- [ ] **Step 3: Write the adapter**

```ts
// packages/core/src/transcription/elevenlabs.ts
import type { SttAdapter, TranscribeInput, TranscribeResult } from './types.js';
import { filenameForMime } from './openai-compatible.js';

export const elevenlabsAdapter: SttAdapter = {
  id: 'elevenlabs',
  async transcribe(model: string, apiKey: string, input: TranscribeInput): Promise<TranscribeResult> {
    const form = new FormData();
    form.append('file', new Blob([input.audio], { type: input.mimeType }), filenameForMime(input.mimeType));
    form.append('model_id', model);
    if (input.language) form.append('language_code', input.language);
    for (const t of input.keyterms ?? []) form.append('keyterms', t);
    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
    });
    if (!res.ok) throw new Error(`elevenlabs ${res.status}: ${await res.text()}`);
    const j: any = await res.json();
    return { text: j?.text ?? '', language: j?.language_code, raw: j };
  },
};
```

- [ ] **Step 4: Slot into the registry**

In `registry.ts`, add `import { elevenlabsAdapter } from './elevenlabs.js';` and change the `elevenlabs` entry:

```ts
  elevenlabs: { id: 'elevenlabs', label: 'ElevenLabs', models: ['scribe_v2', 'scribe_v1'], adapter: elevenlabsAdapter, status: 'ready' },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter dispatch-server exec vitest run src/transcription/elevenlabs.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/transcription/elevenlabs.ts packages/core/src/transcription/elevenlabs.test.ts packages/core/src/transcription/registry.ts
git commit -m "feat(core): ElevenLabs Scribe STT adapter"
```

---

## Task 7: AssemblyAI adapter (upload → submit → poll)

**Files:**
- Create: `packages/core/src/transcription/assemblyai.ts`
- Modify: `packages/core/src/transcription/registry.ts`
- Test: `packages/core/src/transcription/assemblyai.test.ts`

**Interfaces:**
- Produces: `export const assemblyaiAdapter: SttAdapter`. Polls `GET /v2/transcript/{id}` up to `MAX_POLLS` (60) at 1s intervals; injectable via module-level `pollIntervalMs` kept small in tests through a fake timer or short interval — the test mocks `fetch` to complete on the first poll.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/transcription/assemblyai.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { assemblyaiAdapter } from './assemblyai.js';

afterEach(() => vi.restoreAllMocks());

it('uploads, submits, then polls until completed', async () => {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
    const u = String(url); calls.push(u);
    if (u.endsWith('/v2/upload')) return new Response(JSON.stringify({ upload_url: 'https://cdn/aai/xyz' }), { status: 200 });
    if (u.endsWith('/v2/transcript')) return new Response(JSON.stringify({ id: 'tid-1', status: 'queued' }), { status: 200 });
    if (u.endsWith('/v2/transcript/tid-1')) return new Response(JSON.stringify({ status: 'completed', text: 'aai done' }), { status: 200 });
    return new Response('?', { status: 404 });
  });
  const out = await assemblyaiAdapter.transcribe('universal-3-pro', 'aai_key', { audio: Buffer.from('A'), mimeType: 'audio/mp4' });
  expect(out.text).toBe('aai done');
  expect(calls[0]).toContain('/v2/upload');
  expect(calls[1]).toContain('/v2/transcript');
  expect(calls[2]).toContain('/v2/transcript/tid-1');
});

it('throws when the job errors', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
    const u = String(url);
    if (u.endsWith('/v2/upload')) return new Response(JSON.stringify({ upload_url: 'u' }), { status: 200 });
    if (u.endsWith('/v2/transcript')) return new Response(JSON.stringify({ id: 't2', status: 'queued' }), { status: 200 });
    return new Response(JSON.stringify({ status: 'error', error: 'decode failed' }), { status: 200 });
  });
  await expect(assemblyaiAdapter.transcribe('universal-2', 'x', { audio: Buffer.from('a'), mimeType: 'audio/webm' })).rejects.toThrow(/decode failed/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/transcription/assemblyai.test.ts`
Expected: FAIL — cannot resolve `./assemblyai.js`.

- [ ] **Step 3: Write the adapter**

```ts
// packages/core/src/transcription/assemblyai.ts
import type { SttAdapter, TranscribeInput, TranscribeResult } from './types.js';

const BASE = 'https://api.assemblyai.com';
const MAX_POLLS = 60;
const POLL_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const assemblyaiAdapter: SttAdapter = {
  id: 'assemblyai',
  async transcribe(model: string, apiKey: string, input: TranscribeInput): Promise<TranscribeResult> {
    const auth = { authorization: apiKey };
    // 1. upload raw bytes
    const up = await fetch(`${BASE}/v2/upload`, { method: 'POST', headers: { ...auth, 'content-type': 'application/octet-stream' }, body: input.audio });
    if (!up.ok) throw new Error(`assemblyai ${up.status}: ${await up.text()}`);
    const { upload_url } = (await up.json()) as any;
    // 2. submit
    const body: any = { audio_url: upload_url, speech_models: [model] };
    if (input.language) body.language_code = input.language;
    if (input.keyterms?.length) body.keyterms_prompt = input.keyterms;
    const sub = await fetch(`${BASE}/v2/transcript`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!sub.ok) throw new Error(`assemblyai ${sub.status}: ${await sub.text()}`);
    const { id } = (await sub.json()) as any;
    // 3. poll
    for (let i = 0; i < MAX_POLLS; i++) {
      const p = await fetch(`${BASE}/v2/transcript/${id}`, { headers: auth });
      if (!p.ok) throw new Error(`assemblyai ${p.status}: ${await p.text()}`);
      const j: any = await p.json();
      if (j.status === 'completed') return { text: j.text ?? '', language: j.language_code, raw: j };
      if (j.status === 'error') throw new Error(`assemblyai: ${j.error ?? 'transcription error'}`);
      await sleep(POLL_MS);
    }
    throw new Error('assemblyai: transcription timed out');
  },
};
```

- [ ] **Step 4: Slot into the registry**

In `registry.ts`, add `import { assemblyaiAdapter } from './assemblyai.js';` and change the `assemblyai` entry:

```ts
  assemblyai: { id: 'assemblyai', label: 'AssemblyAI', models: ['universal-3-pro', 'universal-2'], adapter: assemblyaiAdapter, status: 'ready' },
```

- [ ] **Step 5: Run tests + full core suite**

Run: `pnpm --filter dispatch-server exec vitest run src/transcription/assemblyai.test.ts && pnpm --filter dispatch-server test`
Expected: adapter tests PASS; full suite green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/transcription/assemblyai.ts packages/core/src/transcription/assemblyai.test.ts packages/core/src/transcription/registry.ts
git commit -m "feat(core): AssemblyAI STT adapter (upload/submit/poll)"
```

---

## Task 8: Settings store fields

**Files:**
- Modify: `packages/web/src/stores/settings.ts`
- Test: `packages/web/src/stores/settings.test.ts` (create if absent)

**Interfaces:**
- Produces on `useSettings`: `sttProvider: string` (default `'groq'`), `sttModel: string` (default `'whisper-large-v3-turbo'`), `sttSecretName: string` (default `''`), setters `setSttProvider(id)`, `setSttModel(id)`, `setSttSecretName(name)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/stores/settings.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useSettings } from './settings';

beforeEach(() => { try { localStorage.clear(); } catch {} });

describe('transcription settings', () => {
  it('has sensible defaults', () => {
    const s = useSettings.getState();
    expect(s.sttProvider).toBe('groq');
    expect(s.sttModel).toBe('whisper-large-v3-turbo');
    expect(s.sttSecretName).toBe('');
  });
  it('persists setters to localStorage', () => {
    useSettings.getState().setSttProvider('openai');
    useSettings.getState().setSttModel('whisper-1');
    useSettings.getState().setSttSecretName('OPENAI_API_KEY');
    expect(useSettings.getState().sttProvider).toBe('openai');
    expect(JSON.parse(localStorage.getItem('dispatch:sttSecretName')!)).toBe('OPENAI_API_KEY');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dispatch-web exec vitest run src/stores/settings.test.ts`
Expected: FAIL — `sttProvider` is undefined.

- [ ] **Step 3: Add fields to the store**

In `packages/web/src/stores/settings.ts`, add to the `SettingsState` interface (after `multiPane: boolean;` / its setter):

```ts
  sttProvider: string;
  sttModel: string;
  sttSecretName: string;
  setSttProvider: (id: string) => void;
  setSttModel: (id: string) => void;
  setSttSecretName: (name: string) => void;
```

Add to the `create(...)` object (after the `multiPane` initializer and its setter):

```ts
  sttProvider: load('dispatch:sttProvider', 'groq'),
  sttModel: load('dispatch:sttModel', 'whisper-large-v3-turbo'),
  sttSecretName: load('dispatch:sttSecretName', ''),
  setSttProvider: (id) => { save('dispatch:sttProvider', id); set({ sttProvider: id }); },
  setSttModel: (id) => { save('dispatch:sttModel', id); set({ sttModel: id }); },
  setSttSecretName: (name) => { save('dispatch:sttSecretName', name); set({ sttSecretName: name }); },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dispatch-web exec vitest run src/stores/settings.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/stores/settings.ts packages/web/src/stores/settings.test.ts
git commit -m "feat(web): transcription settings fields (provider/model/secret)"
```

---

## Task 9: Provider catalog + `api.transcribe`

**Files:**
- Create: `packages/web/src/lib/transcription-providers.ts`
- Modify: `packages/web/src/api/client.ts` (add `transcribe` near `uploadInbox`, ~line 110)
- Test: `packages/web/src/lib/transcription-providers.test.ts`

**Interfaces:**
- Produces: `PROVIDERS: { id: string; label: string; models: { id: string; label: string }[]; status: 'ready' | 'coming-soon' }[]`, `getProvider(id): …`, and `api.transcribe(blob, { provider, model, secretName, mimeType, language? }): Promise<{ text: string; language?: string }>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/lib/transcription-providers.test.ts
import { describe, it, expect } from 'vitest';
import { PROVIDERS, getProvider } from './transcription-providers';

it('exposes ready providers with models and defaults matching the store', () => {
  const groq = getProvider('groq');
  expect(groq?.status).toBe('ready');
  expect(groq?.models.map((m) => m.id)).toContain('whisper-large-v3-turbo');
  expect(PROVIDERS.find((p) => p.id === 'google')?.status).toBe('coming-soon');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dispatch-web exec vitest run src/lib/transcription-providers.test.ts`
Expected: FAIL — cannot resolve `./transcription-providers`.

- [ ] **Step 3: Write the catalog (mirrors the core registry)**

```ts
// packages/web/src/lib/transcription-providers.ts
// Mirrors packages/core/src/transcription/registry.ts. Keep the two in sync.
export interface ProviderModel { id: string; label: string; }
export interface ProviderInfo {
  id: string;
  label: string;
  models: ProviderModel[];
  status: 'ready' | 'coming-soon';
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'groq', label: 'Groq', status: 'ready', models: [
    { id: 'whisper-large-v3-turbo', label: 'Whisper large v3 turbo (fast)' },
    { id: 'whisper-large-v3', label: 'Whisper large v3' },
    { id: 'distil-whisper-large-v3-en', label: 'Distil-Whisper (English)' },
  ] },
  { id: 'openai', label: 'OpenAI', status: 'ready', models: [
    { id: 'gpt-4o-mini-transcribe', label: 'gpt-4o-mini-transcribe' },
    { id: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe' },
    { id: 'whisper-1', label: 'whisper-1' },
  ] },
  { id: 'deepgram', label: 'Deepgram', status: 'ready', models: [
    { id: 'nova-3', label: 'Nova-3' },
    { id: 'nova-2', label: 'Nova-2' },
  ] },
  { id: 'elevenlabs', label: 'ElevenLabs', status: 'ready', models: [
    { id: 'scribe_v2', label: 'Scribe v2' },
    { id: 'scribe_v1', label: 'Scribe v1' },
  ] },
  { id: 'assemblyai', label: 'AssemblyAI', status: 'ready', models: [
    { id: 'universal-3-pro', label: 'Universal-3 Pro' },
    { id: 'universal-2', label: 'Universal-2' },
  ] },
  { id: 'google', label: 'Google Cloud STT', status: 'coming-soon', models: [] },
  { id: 'azure', label: 'Azure AI Speech', status: 'coming-soon', models: [] },
];

export function getProvider(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
```

- [ ] **Step 4: Add `api.transcribe`**

In `packages/web/src/api/client.ts`, add right after the `uploadInbox` method (ends ~line 116):

```ts
  // Voice dictation — upload recorded audio; the daemon resolves the key + calls the provider.
  transcribe: async (
    blob: Blob,
    opts: { provider: string; model: string; secretName: string; mimeType: string; language?: string },
  ): Promise<{ text: string; language?: string }> => {
    const fd = new FormData();
    fd.append('file', blob, 'audio');
    fd.append('provider', opts.provider);
    fd.append('model', opts.model);
    fd.append('secretName', opts.secretName);
    fd.append('mimeType', opts.mimeType);
    if (opts.language) fd.append('language', opts.language);
    const res = await fetch('/api/transcribe', { method: 'POST', body: fd });
    if (!res.ok) {
      const e = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(e.error || `transcribe failed: ${res.status}`);
    }
    return (await res.json()) as { text: string; language?: string };
  },
```

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm --filter dispatch-web exec vitest run src/lib/transcription-providers.test.ts && pnpm --filter dispatch-web exec tsc -b`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/lib/transcription-providers.ts packages/web/src/lib/transcription-providers.test.ts packages/web/src/api/client.ts
git commit -m "feat(web): transcription provider catalog + api.transcribe()"
```

---

## Task 10: `TranscriptionSection` + Settings tab

**Files:**
- Create: `packages/web/src/components/settings/TranscriptionSection.tsx`
- Modify: `packages/web/src/components/settings/SettingsModal.tsx` (tab union `:258`, tab array `:273`, body branch `:354-356`, import)
- Test: `packages/web/src/components/settings/TranscriptionSection.test.tsx`

**Interfaces:**
- Consumes: `useSettings` stt fields (Task 8), `PROVIDERS`/`getProvider` (Task 9), `api.listSecrets` (existing).
- Produces: `export function TranscriptionSection(): JSX.Element`.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/components/settings/TranscriptionSection.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TranscriptionSection } from './TranscriptionSection';
import { useSettings } from '../../stores/settings';

vi.mock('../../api/client', () => ({
  api: { listSecrets: vi.fn().mockResolvedValue([{ name: 'GROQ_API_KEY', value: 'x' }, { name: 'OPENAI_API_KEY', value: 'y' }]) },
}));

beforeEach(() => { try { localStorage.clear(); } catch {} useSettings.setState({ sttProvider: 'groq', sttModel: 'whisper-large-v3-turbo', sttSecretName: '' }); });

it('lists Doppler secret names and updates the store on select', async () => {
  render(<TranscriptionSection />);
  await waitFor(() => expect(screen.getByText('GROQ_API_KEY')).toBeInTheDocument());
  const secretSelect = screen.getByLabelText(/API key/i);
  fireEvent.change(secretSelect, { target: { value: 'OPENAI_API_KEY' } });
  expect(useSettings.getState().sttSecretName).toBe('OPENAI_API_KEY');
});

it('changing provider resets the model to that provider first model', () => {
  render(<TranscriptionSection />);
  fireEvent.change(screen.getByLabelText(/Provider/i), { target: { value: 'openai' } });
  expect(useSettings.getState().sttProvider).toBe('openai');
  expect(useSettings.getState().sttModel).toBe('gpt-4o-mini-transcribe');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dispatch-web exec vitest run src/components/settings/TranscriptionSection.test.tsx`
Expected: FAIL — cannot resolve `./TranscriptionSection`.

- [ ] **Step 3: Write the component**

```tsx
// packages/web/src/components/settings/TranscriptionSection.tsx
import { useEffect, useState } from 'react';
import { useSettings } from '../../stores/settings';
import { PROVIDERS, getProvider } from '../../lib/transcription-providers';
import { api } from '../../api/client';

const label = { fontSize: 11, fontWeight: 600, letterSpacing: 0.4, color: 'var(--color-text-tertiary)' } as const;
const selectStyle = {
  height: 34, padding: '0 10px', background: 'var(--color-elevated)', border: '1px solid var(--color-border)',
  borderRadius: 8, color: 'var(--color-text-primary)', fontSize: 13, minWidth: 200,
} as const;
const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } as const;

export function TranscriptionSection() {
  const { sttProvider, sttModel, sttSecretName, setSttProvider, setSttModel, setSttSecretName } = useSettings();
  const [secrets, setSecrets] = useState<string[]>([]);
  const [secretsErr, setSecretsErr] = useState('');

  useEffect(() => {
    api.listSecrets().then((s) => setSecrets(s.map((x) => x.name)))
      .catch(() => setSecretsErr('Connect Doppler in the Secrets tab to choose a key.'));
  }, []);

  const provider = getProvider(sttProvider);

  function onProvider(id: string) {
    setSttProvider(id);
    const first = getProvider(id)?.models[0]?.id ?? '';
    setSttModel(first); // keep model valid for the new provider
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={label}>TRANSCRIPTION</span>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          Voice dictation on mobile. Your API key stays in Doppler — Dispatch only stores which secret to use.
        </div>

        <div style={rowStyle}>
          <label htmlFor="stt-provider" style={{ fontSize: 13 }}>Provider</label>
          <select id="stt-provider" style={selectStyle} value={sttProvider} onChange={(e) => onProvider(e.target.value)}>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id} disabled={p.status === 'coming-soon'}>
                {p.label}{p.status === 'coming-soon' ? ' (coming soon)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div style={rowStyle}>
          <label htmlFor="stt-model" style={{ fontSize: 13 }}>Model</label>
          <select id="stt-model" style={selectStyle} value={sttModel} onChange={(e) => setSttModel(e.target.value)}>
            {(provider?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>

        <div style={rowStyle}>
          <label htmlFor="stt-secret" style={{ fontSize: 13 }}>API key (Doppler secret)</label>
          <select id="stt-secret" style={selectStyle} value={sttSecretName} onChange={(e) => setSttSecretName(e.target.value)}>
            <option value="">— select a secret —</option>
            {secrets.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        {secretsErr && <div style={{ fontSize: 11.5, color: 'var(--color-status-yellow)' }}>{secretsErr}</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire the tab into `SettingsModal.tsx`**

Add the import near the other section imports (top of file):

```ts
import { TranscriptionSection } from './TranscriptionSection';
```

Change the tab state union (line 258) to include `'transcription'`:

```ts
  const [tab, setTab] = useState<'general' | 'integrations' | 'secrets' | 'tools' | 'transcription'>('general');
```

Add to the tab array (line 273), after `['tools', 'Tools']`:

```ts
['tools', 'Tools'], ['transcription', 'Transcription'],
```

Add the body branch after the `tools` branch (line 356):

```tsx
          {tab === 'transcription' && <TranscriptionSection />}
```

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm --filter dispatch-web exec vitest run src/components/settings/TranscriptionSection.test.tsx && pnpm --filter dispatch-web exec tsc -b`
Expected: PASS (2 tests); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/settings/TranscriptionSection.tsx packages/web/src/components/settings/TranscriptionSection.test.tsx packages/web/src/components/settings/SettingsModal.tsx
git commit -m "feat(web): Transcription settings section (provider/model/secret dropdowns)"
```

---

## Task 11: `useDictation` hook

**Files:**
- Create: `packages/web/src/hooks/useDictation.ts`
- Test: `packages/web/src/hooks/useDictation.test.ts`

**Interfaces:**
- Consumes: `useSettings` stt fields, `api.transcribe`.
- Produces:
  ```ts
  type DictationState = 'idle' | 'recording' | 'transcribing' | 'error';
  interface Dictation {
    state: DictationState;
    error: string | null;
    start(): Promise<void>;
    cancel(): void;
    confirm(): Promise<void>;
    reset(): void;                          // clear error → idle
    getAnalyser(): AnalyserNode | null;     // for the waveform
  }
  function useDictation(onTranscript: (text: string) => void): Dictation
  ```
  Behavior: `start` requests the mic and begins recording; `confirm` stops, uploads, calls `onTranscript`, returns to `idle`; `cancel`/`reset` tear down and return to `idle`. Missing provider/model/secret → `error` state with a config message (no upload).

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/hooks/useDictation.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useDictation } from './useDictation';
import { useSettings } from '../stores/settings';

vi.mock('../api/client', () => ({ api: { transcribe: vi.fn().mockResolvedValue({ text: 'spoken text' }) } }));
import { api } from '../api/client';

// Minimal Web-API mocks (jsdom lacks these).
class FakeRecorder {
  static isTypeSupported = () => true;
  state = 'inactive'; ondataavailable: any = null; onstop: any = null;
  constructor(public stream: any, public opts: any) {}
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['x'], { type: 'audio/webm' }) }); this.onstop?.(); }
}
beforeEach(() => {
  (globalThis as any).MediaRecorder = FakeRecorder;
  (globalThis as any).AudioContext = class { createMediaStreamSource() { return { connect() {} }; } createAnalyser() { return { fftSize: 0, frequencyBinCount: 32, getByteFrequencyData() {} }; } close() {} };
  (navigator as any).mediaDevices = { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) };
  useSettings.setState({ sttProvider: 'groq', sttModel: 'whisper-large-v3-turbo', sttSecretName: 'GROQ_API_KEY' });
  (api.transcribe as any).mockClear();
});

it('records then confirms → transcribes → fires onTranscript → idle', async () => {
  const onTranscript = vi.fn();
  const { result } = renderHook(() => useDictation(onTranscript));
  await act(async () => { await result.current.start(); });
  expect(result.current.state).toBe('recording');
  await act(async () => { await result.current.confirm(); });
  await waitFor(() => expect(result.current.state).toBe('idle'));
  expect(api.transcribe).toHaveBeenCalledTimes(1);
  expect(onTranscript).toHaveBeenCalledWith('spoken text');
});

it('errors (no upload) when transcription is not configured', async () => {
  useSettings.setState({ sttSecretName: '' });
  const onTranscript = vi.fn();
  const { result } = renderHook(() => useDictation(onTranscript));
  await act(async () => { await result.current.start(); });
  await act(async () => { await result.current.confirm(); });
  await waitFor(() => expect(result.current.state).toBe('error'));
  expect(result.current.error).toMatch(/Settings/i);
  expect(api.transcribe).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dispatch-web exec vitest run src/hooks/useDictation.test.ts`
Expected: FAIL — cannot resolve `./useDictation`.

- [ ] **Step 3: Write the hook**

```ts
// packages/web/src/hooks/useDictation.ts
import { useCallback, useRef, useState } from 'react';
import { useSettings } from '../stores/settings';
import { api } from '../api/client';

export type DictationState = 'idle' | 'recording' | 'transcribing' | 'error';

export interface Dictation {
  state: DictationState;
  error: string | null;
  start(): Promise<void>;
  cancel(): void;
  confirm(): Promise<void>;
  reset(): void;
  getAnalyser(): AnalyserNode | null;
}

function pickMimeType(): string {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];
  const MR: any = (globalThis as any).MediaRecorder;
  for (const c of cands) if (MR?.isTypeSupported?.(c)) return c;
  return '';
}

export function useDictation(onTranscript: (text: string) => void): Dictation {
  const [state, setState] = useState<DictationState>('idle');
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>('audio/webm');
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  const teardown = useCallback(() => {
    try { recorderRef.current?.state === 'recording' && recorderRef.current.stop(); } catch { /* */ }
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
    try { audioCtxRef.current?.close(); } catch { /* */ }
    recorderRef.current = null; streamRef.current = null; analyserRef.current = null; audioCtxRef.current = null;
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mime = pickMimeType();
      mimeRef.current = mime || 'audio/webm';
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      recorderRef.current = rec;
      // waveform tap
      const Ctx: any = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx(); audioCtxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
        src.connect(analyser); analyserRef.current = analyser;
      }
      rec.start();
      setState('recording');
    } catch {
      teardown();
      setError('Microphone permission denied.');
      setState('error');
    }
  }, [teardown]);

  const cancel = useCallback(() => { teardown(); setError(null); setState('idle'); }, [teardown]);
  const reset = useCallback(() => { setError(null); setState('idle'); }, []);

  const confirm = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec) { setState('idle'); return; }
    const mime = mimeRef.current;
    const done: Promise<Blob> = new Promise((resolve) => {
      rec.onstop = () => resolve(new Blob(chunksRef.current, { type: mime }));
    });
    try { rec.stop(); } catch { /* */ }
    const blob = await done;
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
    try { audioCtxRef.current?.close(); } catch { /* */ }

    if (blob.size === 0) { teardown(); setState('idle'); return; }

    const { sttProvider, sttModel, sttSecretName } = useSettings.getState();
    if (!sttProvider || !sttModel || !sttSecretName) {
      teardown();
      setError('Set up transcription in Settings → Transcription.');
      setState('error');
      return;
    }
    setState('transcribing');
    try {
      const { text } = await api.transcribe(blob, { provider: sttProvider, model: sttModel, secretName: sttSecretName, mimeType: mime });
      teardown();
      if (text.trim()) onTranscript(text.trim());
      setState('idle');
    } catch (e) {
      teardown();
      setError(e instanceof Error ? e.message : 'Transcription failed.');
      setState('error');
    }
  }, [onTranscript, teardown]);

  const getAnalyser = useCallback(() => analyserRef.current, []);

  return { state, error, start, cancel, confirm, reset, getAnalyser };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dispatch-web exec vitest run src/hooks/useDictation.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/hooks/useDictation.ts packages/web/src/hooks/useDictation.test.ts
git commit -m "feat(web): useDictation hook (record → transcribe → fill)"
```

---

## Task 12: `DictationControl` (waveform + ✓/✕)

**Files:**
- Create: `packages/web/src/components/dictation/DictationControl.tsx`
- Test: `packages/web/src/components/dictation/DictationControl.test.tsx`

**Interfaces:**
- Consumes: `Dictation` (Task 11).
- Produces: `export function DictationControl({ dictation }: { dictation: Dictation }): JSX.Element`. Renders a waveform canvas + timer + ✕/✓ while `recording`; a spinner while `transcribing`; an error row with Retry/Dismiss while `error`.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/components/dictation/DictationControl.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DictationControl } from './DictationControl';

function mk(overrides = {}) {
  return { state: 'recording', error: null, start: vi.fn(), cancel: vi.fn(), confirm: vi.fn(), reset: vi.fn(), getAnalyser: () => null, ...overrides } as any;
}

it('recording: ✓ calls confirm, ✕ calls cancel', () => {
  const d = mk();
  render(<DictationControl dictation={d} />);
  fireEvent.click(screen.getByLabelText(/confirm/i));
  expect(d.confirm).toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText(/cancel/i));
  expect(d.cancel).toHaveBeenCalled();
});

it('error: shows message and Retry calls start', () => {
  const d = mk({ state: 'error', error: 'Microphone permission denied.' });
  render(<DictationControl dictation={d} />);
  expect(screen.getByText(/permission denied/i)).toBeInTheDocument();
  fireEvent.click(screen.getByText(/retry/i));
  expect(d.start).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dispatch-web exec vitest run src/components/dictation/DictationControl.test.tsx`
Expected: FAIL — cannot resolve `./DictationControl`.

- [ ] **Step 3: Write the component**

```tsx
// packages/web/src/components/dictation/DictationControl.tsx
import { useEffect, useRef } from 'react';
import { Check, X, CircleNotch } from '@phosphor-icons/react';
import type { Dictation } from '../../hooks/useDictation';

const iconBtn = (bg: string, color: string) => ({
  flexShrink: 0, width: 40, height: 40, borderRadius: 12, border: 'none',
  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: bg, color,
} as const);

function Waveform({ dictation }: { dictation: Dictation }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const canvas = canvasRef.current; const analyser = dictation.getAnalyser();
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const w = canvas.width, h = canvas.height;
          ctx.clearRect(0, 0, w, h);
          const bins = analyser ? analyser.frequencyBinCount : 32;
          const data = new Uint8Array(bins);
          analyser?.getByteFrequencyData(data);
          const bars = 28; const bw = w / bars;
          const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-accent') || '#3ECF6A';
          ctx.fillStyle = accent.trim() || '#3ECF6A';
          for (let i = 0; i < bars; i++) {
            const v = analyser ? data[Math.floor((i / bars) * bins)] / 255 : 0.15 + 0.1 * Math.abs(Math.sin(i));
            const bh = Math.max(3, v * h);
            ctx.fillRect(i * bw + 1, (h - bh) / 2, bw - 2, bh);
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [dictation]);
  return <canvas ref={canvasRef} width={240} height={40} style={{ flex: 1, minWidth: 0, height: 40 }} />;
}

export function DictationControl({ dictation }: { dictation: Dictation }) {
  const { state, error } = dictation;

  if (state === 'error') {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--color-status-red)' }}>{error}</span>
        <button onClick={() => void dictation.start()} style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 13 }}>Retry</button>
        <button onClick={dictation.reset} style={{ background: 'none', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 13 }}>Dismiss</button>
      </div>
    );
  }

  if (state === 'transcribing') {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, color: 'var(--color-text-secondary)', fontSize: 13 }}>
        <CircleNotch size={18} className="dispatch-spin" /> Transcribing…
      </div>
    );
  }

  // recording
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <button aria-label="Cancel dictation" onClick={dictation.cancel} style={iconBtn('var(--color-hover)', 'var(--color-text-secondary)')}>
        <X size={18} weight="bold" />
      </button>
      <Waveform dictation={dictation} />
      <button aria-label="Confirm dictation" onClick={() => void dictation.confirm()} style={iconBtn('var(--color-accent)', '#06140B')}>
        <Check size={18} weight="bold" />
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dispatch-web exec vitest run src/components/dictation/DictationControl.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/dictation/DictationControl.tsx packages/web/src/components/dictation/DictationControl.test.tsx
git commit -m "feat(web): DictationControl (waveform + confirm/cancel/error)"
```

---

## Task 13: `InputActionsMenu` (the `+` flyout)

**Files:**
- Create: `packages/web/src/components/dictation/InputActionsMenu.tsx`
- Test: `packages/web/src/components/dictation/InputActionsMenu.test.tsx`

**Interfaces:**
- Produces: `export function InputActionsMenu({ onAddFile, onDictate, dictateDisabled, dictateHint }: { onAddFile: () => void; onDictate: () => void; dictateDisabled?: boolean; dictateHint?: string }): JSX.Element`. Renders a `+` button that toggles a small flyout with **Add file** and **Dictate** rows; closes on outside click or after a selection.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/components/dictation/InputActionsMenu.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InputActionsMenu } from './InputActionsMenu';

it('opens the flyout and routes each action', () => {
  const onAddFile = vi.fn(); const onDictate = vi.fn();
  render(<InputActionsMenu onAddFile={onAddFile} onDictate={onDictate} />);
  fireEvent.click(screen.getByLabelText(/more input options/i));
  fireEvent.click(screen.getByText('Add file'));
  expect(onAddFile).toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText(/more input options/i));
  fireEvent.click(screen.getByText('Dictate'));
  expect(onDictate).toHaveBeenCalled();
});

it('disables Dictate with a hint', () => {
  render(<InputActionsMenu onAddFile={vi.fn()} onDictate={vi.fn()} dictateDisabled dictateHint="Set up in Settings" />);
  fireEvent.click(screen.getByLabelText(/more input options/i));
  const dictate = screen.getByText('Dictate').closest('button')!;
  expect(dictate).toBeDisabled();
  expect(screen.getByText('Set up in Settings')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dispatch-web exec vitest run src/components/dictation/InputActionsMenu.test.tsx`
Expected: FAIL — cannot resolve `./InputActionsMenu`.

- [ ] **Step 3: Write the component**

```tsx
// packages/web/src/components/dictation/InputActionsMenu.tsx
import { useEffect, useRef, useState } from 'react';
import { Plus, Paperclip, Microphone } from '@phosphor-icons/react';

interface Props {
  onAddFile: () => void;
  onDictate: () => void;
  dictateDisabled?: boolean;
  dictateHint?: string;
}

const trigger = {
  flexShrink: 0, width: 40, height: 40, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'var(--color-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', cursor: 'pointer',
} as const;

const rowBtn = (disabled?: boolean) => ({
  display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 12px', background: 'none', border: 'none',
  color: disabled ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)', font: '500 14px var(--font-sans)',
  cursor: disabled ? 'default' : 'pointer', textAlign: 'left' as const, borderRadius: 8,
});

export function InputActionsMenu({ onAddFile, onDictate, dictateDisabled, dictateHint }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button aria-label="More input options" onClick={() => setOpen((o) => !o)} style={trigger}>
        <Plus size={20} weight="bold" />
      </button>
      {open && (
        <div style={{
          position: 'absolute', bottom: 48, left: 0, minWidth: 200, padding: 6,
          background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 12,
          boxShadow: '0 12px 34px -10px rgba(0,0,0,.7)', zIndex: 40,
        }}>
          <button style={rowBtn()} onClick={() => { setOpen(false); onAddFile(); }}>
            <Paperclip size={18} /> Add file
          </button>
          <button style={rowBtn(dictateDisabled)} disabled={dictateDisabled} onClick={() => { setOpen(false); onDictate(); }}>
            <Microphone size={18} /> Dictate
          </button>
          {dictateDisabled && dictateHint && (
            <div style={{ padding: '2px 12px 8px', fontSize: 11, color: 'var(--color-text-tertiary)' }}>{dictateHint}</div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dispatch-web exec vitest run src/components/dictation/InputActionsMenu.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/dictation/InputActionsMenu.tsx packages/web/src/components/dictation/InputActionsMenu.test.tsx
git commit -m "feat(web): InputActionsMenu (+ flyout: Add file / Dictate)"
```

---

## Task 14: Wire the agent chat composer (`ChatView`)

**Files:**
- Modify: `packages/web/src/components/tabs/chat/ChatView.tsx`

**Interfaces:**
- Consumes: `useDictation` (Task 11), `DictationControl` (Task 12), `InputActionsMenu` (Task 13), `useIsMobile`, `useSettings`.

- [ ] **Step 1: Add imports + hooks**

At the top of `ChatView.tsx`, add imports:

```ts
import { useIsMobile } from '../../../hooks/useIsMobile';
import { useSettings } from '../../../stores/settings';
import { useDictation } from '../../../hooks/useDictation';
import { DictationControl } from '../../dictation/DictationControl';
import { InputActionsMenu } from '../../dictation/InputActionsMenu';
```

Inside `ChatView`, after the `useDraft` line (line 42), add:

```ts
  const isMobile = useIsMobile();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sttConfigured = useSettings((s) => !!s.sttProvider && !!s.sttModel && !!s.sttSecretName);
  const dictation = useDictation((text) => {
    const next = (draftRef.current ? draftRef.current + ' ' : '') + text;
    draftRef.current = next; setDraft(next);
  });
```

- [ ] **Step 2: Swap the composer left control + input for mobile**

Replace the existing `<label title="Attach file"> … </label>` block (lines 158-169) with:

```tsx
          {isMobile ? (
            <InputActionsMenu
              onAddFile={() => fileInputRef.current?.click()}
              onDictate={() => void dictation.start()}
              dictateDisabled={!sttConfigured}
              dictateHint="Set up in Settings → Transcription"
            />
          ) : (
            <label
              title="Attach file"
              style={{ flexShrink: 0, width: 34, height: 34, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: 'var(--color-hover)', color: 'var(--color-text-secondary)' }}
            >
              <Paperclip size={17} />
              <input type="file" multiple style={{ display: 'none' }} onChange={(e) => { void attachFiles(e.target.files); e.currentTarget.value = ''; }} />
            </label>
          )}
          {/* hidden input the mobile + menu triggers */}
          <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { void attachFiles(e.target.files); e.currentTarget.value = ''; }} />
```

Then wrap the `<textarea>` + send button so that, while dictating on mobile, the control replaces them. Replace the `<textarea …/>` element (lines 170-180) and its following send `<button>` (181-188) with:

```tsx
          {isMobile && dictation.state !== 'idle' ? (
            <DictationControl dictation={dictation} />
          ) : (
            <>
              <textarea
                ref={taRef}
                value={draft}
                onChange={(e) => { setDraft(e.target.value); const el = e.target; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 180) + 'px'; }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } }}
                onPaste={onPaste}
                placeholder="Message…"
                rows={1}
                autoCapitalize="off" autoCorrect="off" spellCheck={false}
                style={{ flex: 1, resize: 'none', border: 'none', outline: 'none', background: 'transparent', color: 'var(--color-text-primary)', font: '400 15px var(--font-sans)', lineHeight: 1.5, maxHeight: 180, overflowY: 'auto' }}
              />
              <button
                onClick={doSend}
                disabled={!draft.trim()}
                title="Send"
                style={{ flexShrink: 0, width: 34, height: 34, borderRadius: 9, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: draft.trim() ? 'pointer' : 'default', background: draft.trim() ? 'var(--color-accent)' : 'var(--color-hover)', color: draft.trim() ? '#06140B' : 'var(--color-text-tertiary)', transition: 'background .15s' }}
              >
                <PaperPlaneTilt size={17} weight="fill" />
              </button>
            </>
          )}
```

- [ ] **Step 3: Typecheck + existing chat tests**

Run: `pnpm --filter dispatch-web exec tsc -b && pnpm --filter dispatch-web exec vitest run src/components/tabs/chat/`
Expected: typecheck clean; existing `useStructuredChat` tests still pass.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/tabs/chat/ChatView.tsx
git commit -m "feat(web): dictation in the agent chat composer (mobile)"
```

---

## Task 15: Wire the coordinator composer (`overseer/Composer`)

**Files:**
- Modify: `packages/web/src/components/overseer/components/Composer.tsx`

**Interfaces:**
- Consumes: same dictation trio; fills via `setComposer`.

- [ ] **Step 1: Add imports + hooks**

At the top of `Composer.tsx` add:

```ts
import { useDictation } from '../../../hooks/useDictation';
import { DictationControl } from '../../dictation/DictationControl';
import { InputActionsMenu } from '../../dictation/InputActionsMenu';
import { useSettings } from '../../../stores/settings';
import { useRef } from 'react';
```

(If `useRef` is already imported from `react` on line 9, add `useRef` to that existing import instead of a second line.)

Inside `Composer`, after the existing `useIsMobile()` line (line 39), add:

```ts
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sttConfigured = useSettings((s) => !!s.sttProvider && !!s.sttModel && !!s.sttSecretName);
  const dictation = useDictation((text) => {
    const cur = useOverseer.getState().composer;
    setComposer(cur + (cur ? ' ' : '') + text);
  });
```

- [ ] **Step 2: Swap the attach label for the `+` menu (mobile)**

Replace the `<label title="Attach file"> … </label>` block (lines 182-204) with:

```tsx
        {isMobile ? (
          <InputActionsMenu
            onAddFile={() => fileInputRef.current?.click()}
            onDictate={() => void dictation.start()}
            dictateDisabled={!sttConfigured}
            dictateHint="Set up in Settings → Transcription"
          />
        ) : (
          <label
            title="Attach file"
            style={{ flex: 'none', width: 32, height: 32, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: 'var(--hover, rgba(255,255,255,.05))', color: 'var(--ts)' }}
          >
            <Paperclip size={16} />
            <input type="file" multiple style={{ display: 'none' }} onChange={(e) => { void attachFiles(e.target.files); e.currentTarget.value = ''; }} />
          </label>
        )}
        <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { void attachFiles(e.target.files); e.currentTarget.value = ''; }} />
```

- [ ] **Step 3: Swap the textarea for the control while dictating (mobile)**

Replace the `<textarea ref={textareaRef} …/>` element (lines 207-229) with:

```tsx
        {isMobile && dictation.state !== 'idle' ? (
          <DictationControl dictation={dictation} />
        ) : (
          <textarea
            ref={textareaRef}
            rows={1}
            value={composer}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={onPaste}
            placeholder={isMobile ? 'Fire a directive…' : 'Fire a directive to Dispatch…'}
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', resize: 'none', color: 'var(--tp)', fontSize: 13.5, lineHeight: 1.5, maxHeight: 120, padding: '7px 2px', fontFamily: 'inherit', overflow: 'auto' }}
          />
        )}
```

- [ ] **Step 4: Typecheck + overseer tests**

Run: `pnpm --filter dispatch-web exec tsc -b && pnpm --filter dispatch-web exec vitest run src/components/overseer/`
Expected: typecheck clean; existing overseer tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/overseer/components/Composer.tsx
git commit -m "feat(web): dictation in the coordinator composer (mobile)"
```

---

## Task 16: Wire the mobile terminal input bar (`TerminalTab`)

**Files:**
- Modify: `packages/web/src/components/tabs/TerminalTab.tsx`

**Interfaces:**
- Consumes: same dictation trio; fills via `setMobileInput`. `isMobile` is already in scope here.

- [ ] **Step 1: Add imports + hooks**

At the top of `TerminalTab.tsx` add:

```ts
import { useDictation } from '../../hooks/useDictation';
import { DictationControl } from '../dictation/DictationControl';
import { InputActionsMenu } from '../dictation/InputActionsMenu';
import { useSettings } from '../../stores/settings';
```

Near the other hooks in the component body (after the `useDraft` line at 93), add:

```ts
  const termFileInputRef = useRef<HTMLInputElement>(null);
  const sttConfigured = useSettings((s) => !!s.sttProvider && !!s.sttModel && !!s.sttSecretName);
  const dictation = useDictation((text) => {
    setMobileInput((mobileInput ? mobileInput + ' ' : '') + text);
  });
```

- [ ] **Step 2: Replace the attach label with the `+` menu**

Replace the `<label title="Attach image"> … </label>` block (lines 452-455) with:

```tsx
            <InputActionsMenu
              onAddFile={() => termFileInputRef.current?.click()}
              onDictate={() => void dictation.start()}
              dictateDisabled={!sttConfigured}
              dictateHint="Set up in Settings → Transcription"
            />
            <input ref={termFileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => { onFiles(e.target.files); e.currentTarget.value = ''; }} />
```

- [ ] **Step 3: Swap the input for the control while dictating**

Replace the `<input value={mobileInput} …/>` element (lines 456-464) with:

```tsx
            {dictation.state !== 'idle' ? (
              <DictationControl dictation={dictation} />
            ) : (
              <input
                value={mobileInput}
                onChange={(e) => setMobileInput(e.target.value)}
                placeholder="Type a message or command…"
                autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
                enterKeyHint="send"
                style={{ flex: 1, minWidth: 0, height: 40, padding: '0 13px', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 12, color: 'var(--color-text-primary)', fontSize: 16 }}
              />
            )}
```

(The `+` menu already sits inside the `{isMobile && ...}` block, so no extra gating is needed. The `Send` button stays; while dictating, the control renders in the input's place and the user confirms there, then Sends.)

- [ ] **Step 4: Typecheck + terminal tests**

Run: `pnpm --filter dispatch-web exec tsc -b && pnpm --filter dispatch-web test`
Expected: typecheck clean; full web suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/tabs/TerminalTab.tsx
git commit -m "feat(web): dictation in the mobile terminal input bar"
```

---

## Task 17: Full build + manual mobile verification

**Files:** none (verification only)

- [ ] **Step 1: Build both packages**

Run: `pnpm -r run build`
Expected: `dispatch-server` and `dispatch-web` build clean (tsc + vite).

- [ ] **Step 2: Run the full test suite**

Run: `pnpm -r run test`
Expected: all core + web tests pass.

- [ ] **Step 3: Configure a provider (one-time)**

In the app: Settings → Secrets → connect Doppler (if not already). Add a `GROQ_API_KEY` secret. Then Settings → Transcription → Provider = Groq, Model = whisper-large-v3-turbo, API key = `GROQ_API_KEY`.

- [ ] **Step 4: Manual test on iOS Safari (standalone PWA) and Android Chrome**

For each of the three inputs — coordinator composer, an agent chat thread, a live terminal:
1. Tap **+** → the little flyout shows **Add file** and **Dictate**.
2. Tap **Dictate** → grant mic → the input row becomes a live waveform that animates as you speak.
3. Tap **✓** → "Transcribing…" → the transcript fills the input; you can edit and send.
4. Tap **✕** mid-record → the input returns unchanged; confirm the mic indicator turns off.
5. With no secret selected, confirm the **Dictate** row is disabled with the Settings hint.

Expected: all pass on both browsers; text appears in the input, never auto-sent, and (for the terminal) is not written to the PTY until you tap Send.

- [ ] **Step 5: Commit any fixups, then finish the branch**

```bash
git status   # ensure clean or commit fixups
```

Then use the `superpowers:finishing-a-development-branch` skill to open a PR.

---

## Self-Review

**Spec coverage:**
- Mobile-only gating → Tasks 14–16 (`useIsMobile` branches). ✓
- `+` flyout (Add file / Dictate) → Task 13, wired 14–16. ✓
- Waveform + ✓/✕ → Task 12. ✓
- Fill-not-submit into all three inputs → Tasks 14 (`setDraft`), 15 (`setComposer`), 16 (`setMobileInput`). ✓
- Server-side multi-provider, adapter framework → Tasks 1, 3, 5–7. ✓
- 5 v1 providers + Google/Azure coming-soon → registry (Task 3) + catalog (Task 9). ✓
- Doppler-referenced key, resolved server-side → Task 2 + service (Task 3) + route (Task 4). ✓
- Transcription settings section (provider/model/secret) → Task 10. ✓
- No transcoding; both mime formats → adapters accept the mime as-sent; `pickMimeType`/`filenameForMime`. ✓
- Error handling (permission, unconfigured, failure, empty) → hook (Task 11) + control (Task 12). ✓
- Testing (backend adapters/service/route, frontend store/hook/menu) → each task's tests + Task 17 manual. ✓

**Placeholder scan:** No TBD/TODO; every code step contains full code; every command has expected output. ✓

**Type consistency:** `TranscribeInput`/`TranscribeResult`/`SttAdapter` (Task 1) used identically in Tasks 3, 5–7. `TranscribeOptions` (Task 3) matches the route's call (Task 4). `Dictation` interface (Task 11) matches `DictationControl` prop (Task 12) and host wiring (14–16). `api.transcribe` signature (Task 9) matches the hook's call (Task 11). Store field names `sttProvider/sttModel/sttSecretName` consistent across Tasks 8, 10, 11, 14–16. ✓
