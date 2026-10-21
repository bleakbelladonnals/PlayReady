import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  root,
  base: './',
  build: {
    outDir: fileURLToPath(new URL('../../../dist/web-client/', import.meta.url)),
    emptyOutDir: true,
  },
});
