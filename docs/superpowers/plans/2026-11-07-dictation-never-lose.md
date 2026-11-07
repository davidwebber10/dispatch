# Dictation: progress, never lose a recording, stay awake — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** (A) Dictation reports its stages: uploading with a percentage, then transcribing with the seconds elapsed. (B) A recording is never lost: it is saved on the device while it is recorded and before it is sent; a failed upload or transcription keeps it with Retry; a Recordings sheet lists recent recordings with Insert, Copy, Transcribe again and Delete. (C) The screen stays awake from the first second of recording until the text is back.

**Owner request (2026-11-07):** "it provides more information on the process, and then it doesn't lose it … confirm that when you're running transcription, it doesn't let the phone lock."

**Architecture:** `lib/recordings.ts` keeps recordings in IndexedDB (`dispatch-recordings`: metadata + audio blob), with a memory backend for tests. The hook writes the chunks to the store every few seconds while recording (a crash or a lock keeps what was said), saves the final blob before the upload, and runs `lib/transcribeJob.ts`: an XHR upload with progress, a transcribing timer, two automatic retries on a network failure, the result written to the store. The wake lock is held through recording, upload and transcription. At app start, a recording left in `recording` or `sending` becomes `failed` ("interrupted") so it shows in the sheet.

## Global Constraints
- Nothing leaves the device except the existing `/api/transcribe` call; the store keeps the newest 30 recordings (and drops audio older than 14 days for done ones).
- Retry after a failure sends the SAME recording (no new recording).
- A network failure retries twice (1 s, 3 s); a 4xx (configuration) does not retry.

## Tasks
1. `lib/recordings.ts` + tests (save, update, list newest first, blob read, delete, prune, interrupted-at-start).
2. `api.transcribeWithProgress` (XHR) + `lib/transcribeJob.ts` + tests (progress events, phases, retries, a 4xx no retry, the store updated).
3. `useDictation`: `uploading` state, `progress`, chunks persisted while recording, wake lock through transcription, `retry()`, `recordingId` + tests.
4. `DictationControl` (stages, Retry, Recordings) + `RecordingsSheet` (Insert / Copy / Transcribe again / Delete) + Settings → Dictation "Recent recordings" + tests.
5. Suites; e2e in the browser with a failing then working transcribe endpoint.
