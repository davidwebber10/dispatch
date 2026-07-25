import { Router } from 'express';
import type { ClaudeLoginService } from '../auth/claude-login.js';

/**
 * Terminal-free Claude login, for the hosted OS surface (design doc §11.2).
 *
 * The whole flow is four calls, so a surface with no terminal can drive it:
 *   GET  /api/claude-auth              → is this box authenticated?
 *   POST /api/claude-auth/login        → start; returns the OAuth URL to open
 *   POST /api/claude-auth/login/code   → submit the code copied after authorising
 *   DELETE /api/claude-auth            → sign out
 */
export function createClaudeAuthRouter(service: ClaudeLoginService): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ authenticated: service.isAuthenticated(), session: service.status() });
  });

  router.post('/login', async (_req, res) => {
    try {
      res.json(await service.start());
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'failed to start login' });
    }
  });

  router.post('/login/code', async (req, res) => {
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    try {
      const session = await service.submitCode(code);
      // A REJECTED code leaves the attempt alive at its prompt (status stays
      // awaiting_code with an error set) so the user can correct and retry inline;
      // only a genuinely dead attempt is a 400.
      if (session.status === 'error') {
        return res.status(400).json({ error: session.error, session });
      }
      res.json(session);
    } catch (err: any) {
      res.status(400).json({
        error: err?.message || 'failed to submit code',
        // 'no_session' tells the client the attempt is gone (daemon restarted, or
        // it was never started here) and it should simply begin again.
        code: err?.code,
      });
    }
  });

  router.post('/login/cancel', (_req, res) => {
    service.cancel();
    res.status(204).end();
  });

  router.delete('/', (_req, res) => {
    service.signOut();
    res.json({ authenticated: false });
  });

  return router;
}
