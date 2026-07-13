import fs from 'fs';
import path from 'path';
import { Router, type Request, type Response, type NextFunction } from 'express';

/**
 * Accent-tinted PWA icons. The stock icons in the web bundle are green; the
 * client re-renders them in the user's accent color (canvas) and uploads them
 * here. They're stored in the daemon's data dir and served in place of the
 * bundled files, so "Add to Home Screen" picks up the tinted icon. iOS
 * snapshots the icon at install time — an already-installed app only changes
 * after removing and re-adding it.
 */
const ICON_NAMES = ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'favicon-32.png'] as const;
const PNG_MAGIC = 0x89504e47;

export function createAppearanceRouter(dataDir: string): Router {
  const dir = path.join(dataDir, 'icons');
  const router = Router();

  // PUT /api/appearance/icons — { icons: { "<name>.png": "<base64>" } }
  router.put('/icons', (req, res) => {
    const icons = req.body?.icons as Record<string, unknown> | undefined;
    if (!icons || typeof icons !== 'object' || !Object.keys(icons).length) {
      return res.status(400).json({ error: 'icons object required' });
    }
    const entries: Array<[string, Buffer]> = [];
    for (const [name, b64] of Object.entries(icons)) {
      if (!(ICON_NAMES as readonly string[]).includes(name)) return res.status(400).json({ error: `unknown icon name: ${name}` });
      if (typeof b64 !== 'string' || b64.length > 3_000_000) return res.status(400).json({ error: `${name}: invalid or oversized payload` });
      const buf = Buffer.from(b64, 'base64');
      if (buf.length < 8 || buf.readUInt32BE(0) !== PNG_MAGIC) return res.status(400).json({ error: `${name} is not a PNG` });
      entries.push([name, buf]);
    }
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, buf] of entries) fs.writeFileSync(path.join(dir, name), buf);
    res.json({ ok: true, written: entries.map(([n]) => n) });
  });

  return router;
}

/** Serve a customized icon from the data dir when one exists, else fall through to the static bundle. */
export function customIconHandler(dataDir: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const name = path.basename(req.path);
    if (!(ICON_NAMES as readonly string[]).includes(name)) return next();
    const p = path.join(dataDir, 'icons', name);
    if (!fs.existsSync(p)) return next();
    res.sendFile(p);
  };
}
