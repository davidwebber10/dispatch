import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { policyRouter, publicRoute } from '../auth/route-policy.js';
import { mountRouter } from '../http/route-registry.js';
import { compressedAssets, createIndexProvider, IMMUTABLE } from '../web-assets.js';
import { pluginAssetHandler } from '../routes/plugins.js';
import { customIconHandler } from '../routes/appearance.js';
import type { PluginRegistry } from '../plugins/registry.js';
import { indexHtmlWithHostContext, type HostContext } from '../profile/host-context.js';

/** Where the built web client is: `DISPATCH_WEB_DIST`, or `packages/web/dist` next to this package (the same from src/ and from dist/). */
export function defaultWebDist(env: NodeJS.ProcessEnv): string {
  return env.DISPATCH_WEB_DIST ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web/dist');
}

/**
 * Serve plugin files, and the built web client (single-origin) when a build is present.
 * The SPA fallback returns index.html for any non-/api, non-WS GET.
 * Returns true when a web build is served.
 */
export function mountWeb(app: express.Express, i: { webDist: string | null; basePath: string; dataDir: string; plugins: PluginRegistry; hostContext?: HostContext | (() => HostContext) }): boolean {
  // Plugin files, with or without a web build (the dev server proxies /plugins here).
  // Routes go through a policyRouter, like every route of the daemon (the profile guard first).
  const assets = policyRouter();
  assets.get('/plugins/:id/*', ...pluginAssetHandler(i.plugins));
  mountRouter(app, '', assets);
  const webDist = i.webDist;
  if (!webDist || !fs.existsSync(path.join(webDist, 'index.html'))) return false;
  // index.html is transformed (not sent as a file) so <base href> matches the mount
  // prefix. It is read again when the file changes (one stat per request): a web rebuild
  // gives new script names, and a page must not get the names of a build that is gone.
  const indexHtml = createIndexProvider(path.join(webDist, 'index.html'), i.basePath);
  // A hosted box or a set profile adds one <meta> with the host context (profile/host-context.ts), so the
  // page knows its profile and theme before the first paint. A local install sends the file unchanged.
  // Read per request: the profile is live (os/profile.ts), so a reload after a change from OS gets it.
  const given = i.hostContext;
  const sendIndex = (_req: express.Request, res: express.Response) => {
    const ctx = typeof given === 'function' ? given() : given;
    res.type('html').send(ctx ? indexHtmlWithHostContext(indexHtml(), ctx) : indexHtml());
  };
  const icons = policyRouter();
  icons.get('/icons/:name', publicRoute, customIconHandler(i.dataDir));
  mountRouter(app, '', icons);
  // Build files: content-hashed, so compressed once and cached forever (web-assets.ts).
  app.use('/assets', compressedAssets(path.join(webDist, 'assets')));
  app.use(express.static(webDist, {
    index: false,
    setHeaders: (res, file) => { if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', IMMUTABLE); },
  }));
  const page = policyRouter();
  page.get(/^\/(?!api\/).*/, publicRoute, sendIndex);
  mountRouter(app, '', page);
  return true;
}
