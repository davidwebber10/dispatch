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
