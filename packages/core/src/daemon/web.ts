import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { publicRoute } from '../auth/route-policy.js';
import { compressedAssets, createIndexProvider, IMMUTABLE } from '../web-assets.js';
import { pluginAssetHandler } from '../routes/plugins.js';
import { customIconHandler } from '../routes/appearance.js';
import type { PluginRegistry } from '../plugins/registry.js';

/** Where the built web client is: `DISPATCH_WEB_DIST`, or `packages/web/dist` next to this package (the same from src/ and from dist/). */
export function defaultWebDist(env: NodeJS.ProcessEnv): string {
  return env.DISPATCH_WEB_DIST ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web/dist');
}

/**
 * Serve plugin files, and the built web client (single-origin) when a build is present.
 * The SPA fallback returns index.html for any non-/api, non-WS GET.
 * Returns true when a web build is served.
 */
export function mountWeb(app: express.Express, i: { webDist: string | null; basePath: string; dataDir: string; plugins: PluginRegistry }): boolean {
  // Plugin files, with or without a web build (the dev server proxies /plugins here).
  app.get('/plugins/:id/*', ...pluginAssetHandler(i.plugins));
  const webDist = i.webDist;
  if (!webDist || !fs.existsSync(path.join(webDist, 'index.html'))) return false;
  // index.html is transformed (not sent as a file) so <base href> matches the mount
  // prefix. It is read again when the file changes (one stat per request): a web rebuild
  // gives new script names, and a page must not get the names of a build that is gone.
  const indexHtml = createIndexProvider(path.join(webDist, 'index.html'), i.basePath);
  const sendIndex = (_req: express.Request, res: express.Response) => {
    res.type('html').send(indexHtml());
  };
  app.get('/icons/:name', publicRoute, customIconHandler(i.dataDir));
  // Build files: content-hashed, so compressed once and cached forever (web-assets.ts).
  app.use('/assets', compressedAssets(path.join(webDist, 'assets')));
  app.use(express.static(webDist, {
    index: false,
    setHeaders: (res, file) => { if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', IMMUTABLE); },
  }));
  app.get(/^\/(?!api\/).*/, publicRoute, sendIndex);
  return true;
}
