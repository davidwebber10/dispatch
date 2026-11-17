import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTranscribeRouter } from './transcribe.js';

function app(svc: any, opts?: { cleanFillers?: () => boolean }) {
  const a = express();
  a.use('/api/transcribe', createTranscribeRouter(svc, opts));
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

  describe('filler cleanup switch', () => {
    const send = (svc: any, opts?: { cleanFillers?: () => boolean }) => request(app(svc, opts)).post('/api/transcribe')
      .field('provider', 'groq').field('model', 'm').field('secretName', 's').field('mimeType', 'audio/webm')
      .attach('file', Buffer.from('a'), { filename: 'a.webm', contentType: 'audio/webm' });
    const spy = () => { const seen: any[] = []; return { seen, svc: { transcribe: async (o: any) => { seen.push(o); return { text: 'x', raw: {} }; } } }; };

    it('passes cleanFillers true when the setting is on', async () => {
      const { seen, svc } = spy();
      await send(svc, { cleanFillers: () => true });
      expect(seen[0].cleanFillers).toBe(true);
    });
    it('passes cleanFillers false when the setting is off', async () => {
      const { seen, svc } = spy();
      await send(svc, { cleanFillers: () => false });
      expect(seen[0].cleanFillers).toBe(false);
    });
    it('reads the setting on every request', async () => {
      const { seen, svc } = spy();
      let on = true;
      const a = app(svc, { cleanFillers: () => on });
      const post = () => request(a).post('/api/transcribe').field('provider', 'g').field('model', 'm').field('secretName', 's')
        .attach('file', Buffer.from('a'), { filename: 'a.webm', contentType: 'audio/webm' });
      await post(); on = false; await post();
      expect(seen.map((o) => o.cleanFillers)).toEqual([true, false]);
    });
    it('is on when no setting reader is given', async () => {
      const { seen, svc } = spy();
      await send(svc);
      expect(seen[0].cleanFillers).toBe(true);
    });
  });
});
