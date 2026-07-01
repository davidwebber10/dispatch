# Voice Dictation — Design Spec

**Date:** 2026-06-30
**Status:** Approved for planning
**Author:** David Webber (with Claude)

## Summary

Add **mobile-only voice dictation** to Dispatch's LLM-chat inputs. On mobile, the
composer's paperclip becomes a **`+`** that opens a **little flyout** (a small
shadcn-styled popover) offering **Add file** and **Dictate**. Choosing **Dictate**
turns the input row into a **live audio waveform** while recording; the user taps
**✓** to finish (or **✕** to cancel). The audio is uploaded to the daemon,
transcribed by a **configurable cloud provider**, and the resulting **text fills the
input** for the user to review and send.

Nothing auto-sends. Nothing is written directly into a PTY. Desktop is untouched —
there, native macOS dictation (Fn-key/hotkey) already writes into any focused field.

## Goals

- Dictate into the three mobile LLM-chat inputs: the coordinator composer, per-agent
  chat threads, and the mobile terminal input bar.
- A single reusable dictation control + `+` flyout, dropped into each host.
- Server-side transcription behind a **pluggable adapter framework** so providers can
  be swapped/added without touching the UI.
- A **Transcription** settings section to pick provider, model, and which **Doppler
  secret** holds the API key. The key value never leaves the daemon.
- Robust on the real mobile targets: **iOS Safari (standalone PWA)** and **Android
  Chrome**.

## Non-goals (v1)

- No spoken replies / TTS. No live conversational / barge-in mode.
- No desktop mic UI (native OS dictation covers it).
- No dictation into plain shell terminals as raw PTY input — only "fill the input."
- No Google Cloud STT or Azure adapters in v1 (listed "coming soon"; they need OAuth
  token-minting / an iOS-mp4 workaround respectively). The framework supports them.
- No server-side audio transcoding (no ffmpeg dependency) — all v1 providers accept
  both browser audio formats natively.

## Interaction model (decided)

- **Dictation, review model.** Tap → talk → review transcript → user sends.
- **Entry point:** the mobile `+` button (replaces the paperclip) → little flyout:
  **Add file** (existing upload flow) · **Dictate** (voice flow).
- **Recording UI:** the input row is replaced in place by a live waveform + an elapsed
  timer + **✕ cancel** / **✓ confirm**.
- **On ✓:** stop recording → "Transcribing…" → text fills the input.
- **On ✕:** discard audio, restore the input untouched.

## Architecture

```
[mobile input row]
   └─ tap +  ──▶ InputActionsMenu (little flyout)
                    ├─ Add file  ──▶ existing attachFiles()/inbox upload
                    └─ Dictate   ──▶ useDictation.start()
                                        getUserMedia({audio})
                                        ├─ MediaRecorder  → audio Blob (webm/opus | mp4/aac)
                                        └─ AudioContext+AnalyserNode → waveform
   [DictationControl replaces the textarea while recording/transcribing]
                                        │ tap ✓
                                        ▼
   POST /api/transcribe  (multipart: file + provider,model,secretName,mimeType,language?)
                                        │
             daemon: SecretsService.getSecret(secretName) → apiKey   (never returned)
                     transcription/service → registry[provider].adapter
                       .transcribe(model, { audio, mimeType, prompt })
                                        │
                                   { text, language? }
                                        ▼
   onTranscript(text)  ──▶  host setter (setComposer | setDraft | setMobileInput)
                            (fills input; user reviews and sends)
```

### Key architectural facts (from codebase + provider research)

- Dispatch has **no server-side LLM SDK**; the daemon shells out to `claude`/`codex`.
  Transcription is therefore a new, self-contained server capability, not an extension
  of an existing AI client.
- **Existing Doppler layer is reused wholesale.** `SecretsService`
  (`packages/core/src/secrets/service.ts`) holds the Doppler token (0600 file, never
  returned to clients) and `DopplerClient.getSecret(project, config, name)` resolves a
  name → value server-side. `GET /api/secrets` already lists secret names for the
  settings dropdown.
- **Browser audio format split:** iOS Safari `MediaRecorder` emits `audio/mp4` (AAC);
  Chrome/Android emits `audio/webm` (Opus). **All five v1 providers accept both
  natively** → no transcoding.
- **One adapter covers three providers:** OpenAI, Groq, and (future) Azure-OpenAI-Whisper
  share the identical `/v1/audio/transcriptions` multipart contract.

## Frontend design (`packages/web/src`)

### New units

| File | Responsibility |
|---|---|
| `hooks/useDictation.ts` | State machine `idle → recording → transcribing → idle\|error`. Owns `getUserMedia`, `MediaRecorder` (mime chosen via `MediaRecorder.isTypeSupported`), `AudioContext`+`AnalyserNode`, the upload call, and teardown. Returns `{ state, error, start(), cancel(), confirm(), getAnalyser() }`. Calls `onTranscript(text)` on success. |
| `components/dictation/DictationControl.tsx` | In-composer recording UI: a `<canvas>` waveform driven by the analyser via `requestAnimationFrame`, elapsed timer, **✕** and **✓**. Rendered in place of the textarea while `state !== 'idle'`. |
| `components/dictation/InputActionsMenu.tsx` | The **`+`** trigger + **little flyout** popover (shadcn prompt-input actions-menu pattern, styled with Dispatch tokens). Rows: **Add file** (icon + label) and **Dictate** (icon + label). Dictate row disabled with a hint when transcription isn't configured. |
| `lib/transcription-providers.ts` | Static provider catalog driving the settings dropdowns: `{ id, label, models: {id,label}[], status: 'ready'\|'coming-soon', docsUrl }[]`. Mirrors the backend registry. |
| `components/settings/TranscriptionSection.tsx` | Settings body: provider dropdown, model dropdown (of selected provider), Doppler-secret dropdown (names from `api.listSecrets()`), and a "Connect Doppler" hint when not connected. |

### Modified units

| File | Change |
|---|---|
| `stores/settings.ts` | Add `sttProvider` (default `'groq'`), `sttModel` (default `'whisper-large-v3-turbo'`), `sttSecretName` (default `''`), each persisted to localStorage via the existing `load`/`save` pattern. **References only, never the key.** |
| `api/client.ts` | Add `transcribe(blob, { provider, model, secretName, mimeType, language? })` — multipart POST to `/api/transcribe`, mirroring `uploadInbox`. Returns `{ text, language? }`. |
| `components/settings/SettingsModal.tsx` | Add a `'transcription'` tab to the tab union/array and a `{tab === 'transcription' && <TranscriptionSection/>}` branch. |
| `overseer/components/Composer.tsx` | Mobile: replace the paperclip with `<InputActionsMenu>`; wire Dictate → `<DictationControl onTranscript={t => setComposer(useOverseer.getState().composer + t)}>`. Desktop: unchanged (keep paperclip). |
| `tabs/chat/ChatView.tsx` | Same, with `setDraft` (append to current draft). |
| `tabs/TerminalTab.tsx` | Same, inside the existing `{isMobile && ...}` input bar; wire Dictate → `setMobileInput` (append). Fills the input only — `sendMobileInput()` is still user-triggered. |

### Mobile gating

The `+`/Dictate affordance renders only when `useIsMobile()` is true. On desktop the
composers keep their current paperclip and no mic. This shrinks the test matrix to iOS
Safari (PWA) and Android Chrome.

### Recording & waveform details

- **Mime selection:** try `'audio/webm;codecs=opus'`, then `'audio/webm'`, then
  `'audio/mp4'`; store the actually-chosen `mimeType` and send it with the upload
  (iOS reports `audio/mp4`). Never assume the format — read it back.
- **Waveform:** an `AnalyserNode` (`fftSize` ~1024) fed by a `MediaStreamSource`; a rAF
  loop reads `getByteTimeDomainData` (or frequency bins) and draws bars/line on a
  canvas. The `MediaRecorder` and the analyser share one `getUserMedia` stream.
- **Teardown (every exit path):** stop `MediaRecorder`, stop all `MediaStreamTrack`s,
  close the `AudioContext`, cancel the rAF. Prevents the iOS "mic stays hot" bug.

## Backend design (`packages/core/src`)

### New module: `transcription/`

| File | Responsibility |
|---|---|
| `types.ts` | `TranscribeInput { audio: Buffer; mimeType: string; language?: string; prompt?: string; keyterms?: string[] }`, `TranscribeResult { text: string; language?: string; raw: unknown }`, `SttAdapter { id; transcribe(model, key, input): Promise<TranscribeResult> }`. |
| `openai-compatible.ts` | Multipart POST to a configurable base URL (`file`, `model`, `prompt?`, `language?`), `Authorization: Bearer`, response `{ text }`. Serves **OpenAI** (`https://api.openai.com/v1`) and **Groq** (`https://api.groq.com/openai/v1`). |
| `deepgram.ts` | Raw-body POST to `https://api.deepgram.com/v1/listen?model=…&smart_format=true`, `Authorization: Token`, `Content-Type: <mimeType>`. Text at `results.channels[0].alternatives[0].transcript`. `keyterms → keyterm=` (Nova-3). |
| `elevenlabs.ts` | Multipart POST to `https://api.elevenlabs.io/v1/speech-to-text`, header `xi-api-key`, fields `file` + `model_id` (+ `language_code?`, `keyterms?`). Text at top-level `text`. |
| `assemblyai.ts` | 3-step async: `POST /v2/upload` (raw binary, header `authorization`) → `POST /v2/transcript` `{ audio_url, speech_models, keyterms_prompt? }` → poll `GET /v2/transcript/{id}` until `status==='completed'`; text at top-level `text`. |
| `registry.ts` | `provider-id → { adapter, models: string[], baseURL?, status }`. Single source of truth mirrored by the frontend catalog. Includes `google`/`azure` entries marked `coming-soon` (no adapter yet). |
| `service.ts` | `transcribe({ provider, model, secretName, audio, mimeType, language })`: validate provider/model, `secrets.getSecret(secretName)` → key (throws if missing/not-connected), dispatch to the adapter. |

### New route: `routes/transcribe.ts`

- `POST /api/transcribe` — `multer` single field `file` (25 MB cap; matches provider
  limits). Form fields: `provider`, `model`, `secretName`, `mimeType`, `language?`.
- Returns `{ text, language? }`.
- Errors: `400` (unknown/coming-soon provider, missing secret, Doppler not connected,
  empty audio) · `413` (too large) · `502` (provider upstream error).
- Mounted in `server.ts` alongside the other routers, with `SecretsService` injected
  (same pattern as `createSecretsRouter`).

### One change to existing code

- `SecretsService.getSecret(name): Promise<string | null>` — reads stored
  `project`/`config`/`token`, calls `DopplerClient.getSecret(project, config, name)`.
  Throws `'Doppler is not connected'` if unconfigured. Used only server-side.

### Provider catalog (v1)

| Provider | Default model | Endpoint | Auth | Adapter |
|---|---|---|---|---|
| **Groq** (default) | `whisper-large-v3-turbo` | `…groq.com/openai/v1/audio/transcriptions` | `Bearer` | openai-compatible |
| OpenAI | `gpt-4o-mini-transcribe` | `…openai.com/v1/audio/transcriptions` | `Bearer` | openai-compatible |
| Deepgram | `nova-3` | `…deepgram.com/v1/listen` | `Token` | deepgram |
| ElevenLabs | `scribe_v2` | `…elevenlabs.io/v1/speech-to-text` | `xi-api-key` | elevenlabs |
| AssemblyAI | `universal-3-pro` | `…assemblyai.com/v2/*` | raw `authorization` | assemblyai |
| Google STT v2 | — | — | — | coming-soon |
| Azure AI Speech | — | — | — | coming-soon |

### Priming (v1-light)

For openai-compatible providers, seed `prompt` with a short static hint (e.g.
"Technical dictation; may include file paths, camelCase identifiers, and CLI flags.").
Other adapters accept `keyterms` where supported. Richer seeding (recent thread text /
project file names) is a clean follow-up through the same `prompt`/`keyterms` fields.

## Error handling & edge cases

- **Mic permission denied** → inline error in the control; revert to the textarea.
- **Not configured** (no provider/model/secret) → Dictate row disabled with a hint
  pointing to Settings → Transcription.
- **Transcription failure** → error state with **Retry** / **Cancel**; the recorded
  audio is retained until dismissed so Retry needs no re-recording.
- **App backgrounded mid-record** (iOS suspends media) → detect `visibilitychange` /
  recorder `error`; stop cleanly and surface "recording interrupted."
- **Empty / very short clip** → skip upload, restore the input.
- **Large clip** → client soft-caps duration (e.g. ~2 min) and the route enforces
  25 MB.

## Testing

- **Backend (vitest + supertest):** each adapter's request-building against a mocked
  `fetch` (URL, headers, field names, response parsing — including AssemblyAI's poll
  loop); `registry` lookup; `SecretsService.getSecret`; `/api/transcribe` error codes.
- **Frontend (vitest + RTL):** `useDictation` state machine with mocked
  `getUserMedia`/`MediaRecorder`/`AudioContext`; the settings store defaults + setters;
  `InputActionsMenu` (renders rows, Dictate disabled when unconfigured); each host
  calls the correct setter via `onTranscript`.
- **Manual:** iOS Safari (standalone PWA) + Android Chrome — record in all three inputs,
  waveform animates, ✓ transcribes and fills, ✕ cancels cleanly, mic light turns off.

## Suggested build order

1. **Backend transcription module + route** (types, openai-compatible adapter,
   registry, service, `/api/transcribe`, `SecretsService.getSecret`) — testable in
   isolation with Groq.
2. **Settings:** provider catalog, `stores/settings` fields, `TranscriptionSection`,
   `SettingsModal` tab, `api.transcribe`.
3. **Reusable UI:** `useDictation`, `DictationControl`, `InputActionsMenu`.
4. **Wire the three hosts** (Composer, ChatView, TerminalTab), mobile-gated.
5. **Remaining adapters:** Deepgram, ElevenLabs, AssemblyAI.
6. **Manual mobile verification** (iOS PWA + Android Chrome).

## Open questions / future

- Server-side (cross-device) transcription config instead of per-browser localStorage.
- Google + Azure adapters (OAuth token-minting; Azure iOS-mp4 via Azure-OpenAI-Whisper).
- Context-rich priming from the active thread.
- Optional TTS / hands-free mode (explicitly out of scope now).
