/**
 * Dictation recordings kept on this device (owner request 2026-11-07: "it doesn't lose it"). A
 * recording is written while it is recorded and before it is sent, so a lock, a reload or a failed
 * upload keeps it; the Recordings sheet lists them with Retry, Insert, Copy and Delete. IndexedDB
 * in the app; a memory backend in tests. Nothing here leaves the device.
 */
export type RecordingStatus = 'recording' | 'pending' | 'sending' | 'done' | 'failed';
export interface Recording {
  id: string;
  createdAt: string;
  mimeType: string;
  durationMs: number;
  status: RecordingStatus;
  text?: string;
  error?: string;
  attempts: number;
  bytes: number;
}
export interface RecordingBackend {
  put(rec: Recording, blob?: Blob): Promise<void>;
  get(id: string): Promise<Recording | null>;
  all(): Promise<Recording[]>;
  blob(id: string): Promise<Blob | null>;
  remove(id: string): Promise<void>;
}

export const KEEP_RECORDINGS = 30;
const OLD_AUDIO_MS = 14 * 24 * 3600 * 1000;

export function memoryBackend(): RecordingBackend {
  const recs = new Map<string, Recording>(); const blobs = new Map<string, Blob>();
  return {
    async put(rec, blob) { recs.set(rec.id, { ...rec }); if (blob) blobs.set(rec.id, blob); },
    async get(id) { const r = recs.get(id); return r ? { ...r } : null; },
    async all() { return [...recs.values()].map((r) => ({ ...r })); },
    async blob(id) { return blobs.get(id) ?? null; },
    async remove(id) { recs.delete(id); blobs.delete(id); },
  };
}

const DB = 'dispatch-recordings';
function idbBackend(): RecordingBackend {
  let dbp: Promise<IDBDatabase> | null = null;
  const open = () => (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { const db = req.result; db.createObjectStore('meta', { keyPath: 'id' }); db.createObjectStore('audio'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbp = null; reject(req.error); };
  }));
  const tx = async <T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> => {
    const db = await open();
    return new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(stores, mode);
      const r = fn(t);
      t.oncomplete = () => resolve(r ? (r as IDBRequest<T>).result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };
  return {
    async put(rec, blob) { await tx(['meta', 'audio'], 'readwrite', (t) => { t.objectStore('meta').put(rec); if (blob) t.objectStore('audio').put(blob, rec.id); }); },
    async get(id) { return ((await tx<Recording>(['meta'], 'readonly', (t) => t.objectStore('meta').get(id))) ?? null); },
    async all() { return ((await tx<Recording[]>(['meta'], 'readonly', (t) => t.objectStore('meta').getAll())) ?? []); },
    async blob(id) { return ((await tx<Blob>(['audio'], 'readonly', (t) => t.objectStore('audio').get(id))) ?? null); },
    async remove(id) { await tx(['meta', 'audio'], 'readwrite', (t) => { t.objectStore('meta').delete(id); t.objectStore('audio').delete(id); }); },
  };
}

let backend: RecordingBackend | null = null;
/** Tests set a memory backend; the app uses IndexedDB (or memory where there is none). */
export function setRecordingBackend(b: RecordingBackend): void { backend = b; }
function store(): RecordingBackend {
  if (!backend) backend = typeof indexedDB !== 'undefined' ? idbBackend() : memoryBackend();
  return backend;
}

/** Strictly increasing times, so two recordings in one millisecond still sort. */
let lastAt = 0;
const nextAt = (): string => { const t = Math.max(Date.now(), lastAt + 1); lastAt = t; return new Date(t).toISOString(); };
const newId = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export async function saveRecording(fields: Pick<Recording, 'mimeType' | 'durationMs' | 'status'> & Partial<Recording>, blob: Blob): Promise<Recording> {
  const rec: Recording = { id: newId(), createdAt: nextAt(), attempts: 0, ...fields, bytes: blob.size };
  await store().put(rec, blob);
  return rec;
}

export async function updateRecording(id: string, patch: Partial<Omit<Recording, 'id'>>, blob?: Blob): Promise<Recording | null> {
  const cur = await store().get(id);
  if (!cur) return null;
  const next: Recording = { ...cur, ...patch, ...(blob ? { bytes: blob.size } : {}) };
  await store().put(next, blob);
  return next;
}

/** Newest first. */
export async function listRecordings(): Promise<Recording[]> {
  return (await store().all()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export async function getRecording(id: string): Promise<Recording | null> { return store().get(id); }
export async function getRecordingBlob(id: string): Promise<Blob | null> { return store().blob(id); }
export async function deleteRecording(id: string): Promise<void> { await store().remove(id); }

/** Keep the newest KEEP_RECORDINGS; drop done ones older than two weeks. */
export async function pruneRecordings(now = Date.now()): Promise<void> {
  const rows = await listRecordings();
  for (const [i, r] of rows.entries()) {
    const old = r.status === 'done' && now - new Date(r.createdAt).getTime() > OLD_AUDIO_MS;
    if (i >= KEEP_RECORDINGS || old) await store().remove(r.id);
  }
}

/** At app start: a recording left mid-way (the page closed while recording or sending) becomes failed, audio kept. */
export async function markInterrupted(): Promise<number> {
  let n = 0;
  for (const r of await listRecordings()) {
    if (r.status === 'recording' || r.status === 'sending') {
      await updateRecording(r.id, { status: 'failed', error: 'The app closed before this was transcribed (interrupted). Transcribe it again from here.' });
      n++;
    }
  }
  return n;
}
