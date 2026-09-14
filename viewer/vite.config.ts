import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Relative asset and data URLs, so dist/ can be served from any path.
  base: './',
  // The viewer imports harness types and helpers straight out of ../src.
  server: { fs: { allow: [repoRoot] } },
  preview: { allowedHosts: true },
});
