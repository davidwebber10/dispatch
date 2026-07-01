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
