import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  // The viewer imports schemas and helpers straight out of ../src, so Vite has to be
  // allowed to resolve above the package root.
  server: { allowedHosts: ['fedora--5173.getbb.app'], fs: { allow: [repoRoot] } },
  build: {
    // A single self-contained file, openable over file://.
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    chunkSizeWarningLimit: 100_000,
    cssCodeSplit: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
