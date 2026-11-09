import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import type { Plugin } from 'vite';
import fs from 'node:fs';
import { build, type Rollup } from 'vite';
import { trimIconWeights, duotoneIcons, iconDefsName, staticClosure, shellPreloadLinks, sharedChunkNames } from './scripts/build-plugins.mjs';

const SRC = path.resolve(import.meta.dirname, 'src');
const PHONE_SHELL = '/src/components/mobile/MobileApp.tsx';
const DESKTOP_SHELL = '/src/components/layout/DesktopShell.tsx';
const THREAD_VIEW = '/src/components/tabs/TabHost.tsx';
const slashes = (id: string) => id.split(path.sep).join('/');

/** Build only: each icon module keeps the weights the app draws (scripts/build-plugins.mjs). */
function iconWeights(): Plugin {
  let duotone: Set<string> | null = null;
  return {
    name: 'dispatch:icon-weights',
    apply: 'build',
    buildStart() {
      const files = (fs.readdirSync(SRC, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
      duotone = duotoneIcons(files.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')));
    },
    transform(code, id) {
      const name = iconDefsName(id);
      if (!name) return null;
      const out = trimIconWeights(code, { keepDuotone: duotone === null || duotone.has(name) });
      return out === null ? null : { code: out, map: null };
    },
  };
}

/**
 * Build only: index.html preloads the chunks of the shell for the page's width, so the shell adds no
 * round trip after the entry (scripts/build-plugins.mjs). The desktop also preloads the thread view:
 * it shows a thread at once. The phone starts on the list and fetches the thread view when idle.
 */
function shellPreload(): Plugin {
  const SHELLS = { phone: [PHONE_SHELL], desktop: [DESKTOP_SHELL, THREAD_VIEW] };
  return {
    name: 'dispatch:shell-preload',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        if (!ctx.bundle) return [];
        const chunks: Record<string, { imports: string[] }> = {};
        const byModule = new Map<string, string>();
        let entry: string | undefined;
        for (const c of Object.values(ctx.bundle)) {
          if (c.type !== 'chunk') continue;
          chunks[c.fileName] = { imports: c.imports };
          if (c.isEntry) entry = c.fileName;
          // By module, not by facade: a module that another chunk also imports statically has no chunk of its own.
          for (const id of Object.keys(c.modules)) byModule.set(slashes(id), c.fileName);
        }
        const filesOf = (suffixes: string[]) => staticClosure(chunks, suffixes.map((sfx) => {
          const hit = [...byModule].find(([id]) => id.endsWith(sfx));
          if (!hit) throw new Error(`shell-preload: no chunk holds ${sfx}`);
          return hit[1];
        }));
        if (!entry) return [];
        const links = shellPreloadLinks({ entry: staticClosure(chunks, [entry]), phone: filesOf(SHELLS.phone), desktop: filesOf(SHELLS.desktop) });
        return links.map((l) => ({
          tag: 'link',
          attrs: { rel: 'modulepreload', crossorigin: true, href: `./${l.href}`, ...(l.media ? { media: l.media } : {}) },
          injectTo: 'head' as const,
        }));
      },
    },
  };
}

/** The large vendor groups. Their names are stable: the bundle check and the reports use them. */
function vendorChunk(id: string): string | undefined {
  // Rollup's CommonJS helper: with React, the chunk that imports no other. In the entry chunk it would make React import the entry.
  if (id === '\0commonjsHelpers.js') return 'react';
  if (!id.includes('/node_modules/')) return undefined;
  if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
  if (/\/node_modules\/@xterm\//.test(id)) return 'terminal';
  if (/\/node_modules\/(marked|marked-highlight|dompurify)\//.test(id)) return 'markdown';
  // highlight.js: the core and the first-load languages go with markdown; lib/highlightLanguages.ts keeps the rest in its own chunk.
  if (/\/node_modules\/highlight\.js\/(?:lib|es)\/(core|languages\/(javascript|typescript|json|bash|diff|xml|plaintext))\.js/.test(id)) return 'markdown';
  return undefined;
}

/** Set by sharedChunks() before the real build: module id -> "index" | "common" | "views". */
let sharedNames: Map<string, string> | null = null;
const FIRST_PASS = 'DISPATCH_WEB_CHUNK_PASS';

/**
 * Build only: runs the build one time in memory first, and names the app's shared code from where
 * Rollup placed it (scripts/build-plugins.mjs, sharedChunkNames). The result: the first screen loads
 * the entry, the three vendor chunks it needs, "common" and one shell, and not a file for each
 * combination of views that share a module.
 */
function sharedChunks(): Plugin {
  return {
    name: 'dispatch:shared-chunks',
    apply: 'build',
    async config() {
      if (process.env[FIRST_PASS]) return; // this is the first pass
      process.env[FIRST_PASS] = '1';
      try {
        const out = await build({ configFile: import.meta.filename, logLevel: 'silent', build: { write: false, manifest: false } });
        const output = (Array.isArray(out) ? out[0] : out as Rollup.RollupOutput).output;
        const chunks = output.filter((c): c is Rollup.OutputChunk => c.type === 'chunk')
          .map((c) => ({ fileName: c.fileName, isEntry: c.isEntry, isDynamicEntry: c.isDynamicEntry, imports: c.imports, moduleIds: Object.keys(c.modules) }));
        const isShell = (id: string) => slashes(id).endsWith(PHONE_SHELL) || slashes(id).endsWith(DESKTOP_SHELL);
        sharedNames = sharedChunkNames(chunks, isShell, (id) => vendorChunk(id) !== undefined);
      } finally { delete process.env[FIRST_PASS]; }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), iconWeights(), sharedChunks(), shellPreload()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.DISPATCH_API_TARGET ?? 'http://localhost:3456', changeOrigin: true, ws: true },
      // Plugin bundles come from the daemon too (docs/superpowers/specs/2026-11-07-plugins-design.md).
      '/plugins': { target: process.env.DISPATCH_API_TARGET ?? 'http://localhost:3456', changeOrigin: true },
    },
  },
  base: './',
  build: {
    outDir: 'dist',
    // Keep the files of the last build: an open tab still asks for its lazy chunks after a rebuild.
    // scripts/prune-assets.mjs (run by `pnpm build`) then removes the builds older than that; it reads
    // the manifest to know which files belong to which build.
    emptyOutDir: false,
    manifest: true,
    // One stylesheet (W2-E). The styles of the lazy views are a few kB; as files of their own each
    // one is a request that starts only after its view's code arrived (one more round trip).
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // Stable names for the large vendor groups (engineering program 2026-11-09, W2-E), so the
        // bundle check and the reports can name them and a release that does not touch a group keeps its file.
        // The app's own shared code goes to two chunks (sharedChunks above): "common" for the
        // first screen of the shells, "views" for what the lazy views share.
        manualChunks(id) {
          return vendorChunk(id) ?? sharedNames?.get(id);
        },
      },
    },
  },
});
