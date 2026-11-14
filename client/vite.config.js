import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: { '@shared': path.resolve(__dirname, '../shared') } },
  server: {
    port: 5173,
    host: true,
    fs: { allow: ['..'] },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1200 },
});
