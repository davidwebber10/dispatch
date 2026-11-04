import type { Router } from 'express';
import { policyRouter } from '../auth/route-policy.js';
import { PushLimitError, type PushService } from '../push/service.js';
import { deviceLabelFromUserAgent } from '../push/label.js';
import { isAllowedPushEndpoint } from '../push/endpoints.js';

export function createPushRouter(push: PushService): Router {
  const router = policyRouter();
  router.get('/key', (_req, res) => res.json({ publicKey: push.getPublicKey() }));
  router.post('/subscribe', (req, res) => {
    const { deviceId, subscription } = req.body ?? {};
    if (typeof deviceId !== 'string' || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: 'deviceId and a full subscription are required' });
    }
    if (!isAllowedPushEndpoint(subscription.endpoint)) {
      return res.status(400).json({ error: 'That push address is not from a supported push service.' });
    }
    try {
      push.subscribe(deviceId, subscription, deviceLabelFromUserAgent(req.headers['user-agent']));
    } catch (err) {
      if (err instanceof PushLimitError) return res.status(429).json({ error: err.message });
      throw err;
    }
    res.json({ ok: true });
  });
  // Settings > Access: the stored subscriptions and a per-device revoke. Owner only (the policyRouter default), so a
  // thread key gets 403. The list shows the push service host, never the push address or keys.
  router.get('/subscriptions', (_req, res) => res.json({ subscriptions: push.listSubscriptions() }));
  router.delete('/subscriptions/:deviceId', (req, res) => {
    if (!push.revoke(req.params.deviceId)) return res.status(404).json({ error: 'That push subscription was not found.' });
    res.json({ ok: true });
  });
  router.post('/unsubscribe', (req, res) => {
    if (typeof req.body?.deviceId !== 'string') return res.status(400).json({ error: 'deviceId required' });
    push.unsubscribe(req.body.deviceId);
    res.json({ ok: true });
  });
  router.post('/presence', (req, res) => {
    const { deviceId, foreground, activeTerminalId } = req.body ?? {};
    if (typeof deviceId !== 'string' || typeof foreground !== 'boolean') return res.status(400).json({ error: 'deviceId + foreground required' });
    if (activeTerminalId !== undefined && activeTerminalId !== null && typeof activeTerminalId !== 'string') {
      return res.status(400).json({ error: 'activeTerminalId must be a string or null' });
    }
    push.setPresence(deviceId, foreground, activeTerminalId ?? null);
    res.json({ ok: true });
  });
  return router;
}
