import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
  },
});
