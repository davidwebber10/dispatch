import type { Router } from 'express';
import { needs, keyRoute, policyRouter } from '../auth/route-policy.js';
import { allowRule, readRule } from '../auth/key-rules.js';
import { redactKeysDeep } from '../auth/redact-keys.js';
import type { MessageJournal } from '../journal/journal.js';
import { publicItem } from '../journal/replay.js';

/**
 * GET /api/terminals/:terminalId/journal?before=&after=&limit= : a page of the thread's message
 * journal (W3-D), oldest first. With no parameter: the newest `limit` items. `before=<seq>`: the
 * items before that sequence (older history, for scroll back). `after=<seq>`: the items after it.
 *
 * The answer is `{ items, firstSeq, lastSeq, hasMore }`. Each item is `{ seq, kind, at, payload }`:
 * `payload` is the Claude-shaped event that the structured socket also sends, so a client folds a
 * page the way it folds the socket. `firstSeq` is the oldest sequence the journal has for the
 * thread; below it, a Claude or Codex thread reads the transcript route (`/conversation`).
 *
 * The key rules are the ones of the conversation route: what a key may read there, it may read here.
 * `threadExists` answers 404 for an id that is no thread (the journal itself knows no thread list).
 */
export function createJournalRouter(journal: MessageJournal, threadExists: (terminalId: string) => boolean): Router {
  const router = policyRouter();
  const readRules = { thread: readRule, roleRun: readRule, chat: allowRule, summarizer: allowRule, plugin: needs('read:threads') };

  router.get('/terminals/:terminalId/journal', keyRoute(readRules), (req, res) => {
    const id = req.params.terminalId;
    const read = (name: string): number | undefined | null => {
      const raw = req.query[name];
      if (raw === undefined) return undefined;
      return typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : null;
    };
    const before = read('before');
    const after = read('after');
    const limit = read('limit');
    if (before === null || after === null || limit === null || limit === 0) return void res.status(400).json({ error: 'before, after and limit must be whole numbers (limit at least 1)' });
    if (before !== undefined && after !== undefined) return void res.status(400).json({ error: 'Give before or after, not both' });
    try {
      if (!threadExists(id)) return void res.status(404).json({ error: 'Thread not found' });
      const page = journal.page(id, { beforeSeq: before, afterSeq: after, limit });
      res.json(redactKeysDeep({ items: page.items.map(publicItem), firstSeq: page.firstSeq, lastSeq: page.lastSeq, hasMore: page.hasMore }));
    } catch (err) {
      console.error(`[journal] page of ${id} failed:`, err);
      res.status(500).json({ error: 'Could not read the journal' });
    }
  });

  /**
   * GET /api/terminals/:terminalId/journal/images/:imageId : the bytes of an image that the journal
   * keeps outside its payload (final review of v4.5.0, I2). An item over the payload limit has, in
   * place of the base64 data of an image, `source: { type: 'journal_image', id, media_type, thread }`;
   * the client reads the picture from here. The key rules are the ones of the journal page.
   *
   * Only PNG, JPEG, GIF and WebP are ever stored (journal.ts), and the answer cannot be read as a
   * page: `nosniff`, and a policy that allows nothing. An id belongs to its thread: another
   * thread's id is 404.
   */
  router.get('/terminals/:terminalId/journal/images/:imageId', keyRoute(readRules), (req, res) => {
    const { terminalId, imageId } = req.params;
    try {
      if (!/^[0-9a-f]{64}$/.test(imageId) || !threadExists(terminalId)) return void res.status(404).json({ error: 'Image not found' });
      const image = journal.image(terminalId, imageId);
      if (!image) return void res.status(404).json({ error: 'Image not found' });
      res.setHeader('Content-Type', image.mediaType);
      res.setHeader('Content-Length', String(image.data.length));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable'); // the id is the hash of the bytes
      res.end(image.data);
    } catch (err) {
      console.error(`[journal] image of ${terminalId} failed:`, err);
      res.status(500).json({ error: 'Could not read the image' });
    }
  });

  return router;
}
