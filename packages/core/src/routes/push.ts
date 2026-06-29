import { Router } from 'express';
import type { PushService } from '../push/service.js';

export function createPushRouter(push: PushService): Router {
  const router = Router();
  router.get('/key', (_req, res) => res.json({ publicKey: push.getPublicKey() }));
  router.post('/subscribe', (req, res) => {
    const { deviceId, subscription } = req.body ?? {};
    if (typeof deviceId !== 'string' || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: 'deviceId and a full subscription are required' });
    }
    push.subscribe(deviceId, subscription);
    res.json({ ok: true });
  });
  router.post('/unsubscribe', (req, res) => {
    if (typeof req.body?.deviceId !== 'string') return res.status(400).json({ error: 'deviceId required' });
    push.unsubscribe(req.body.deviceId);
    res.json({ ok: true });
  });
  router.post('/presence', (req, res) => {
    const { deviceId, foreground } = req.body ?? {};
    if (typeof deviceId !== 'string' || typeof foreground !== 'boolean') return res.status(400).json({ error: 'deviceId + foreground required' });
    push.setPresence(deviceId, foreground);
    res.json({ ok: true });
  });
  return router;
}
