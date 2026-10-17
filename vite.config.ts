import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = 'http://localhost:3000';

export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
    // Les polices ne sont jamais intégrées en data: (la CSP impose font-src 'self') ; le reste suit le défaut de Vite (4 Ko).
    assetsInlineLimit: (file: string, content: Buffer) => (/\.woff2?$/.test(file) ? false : content.length < 4096),
  },
  server: {
    port: 5173,
    strictPort: true,
    // En développement, Vite sert l'interface et relaie l'API vers le serveur Fastify.
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/internal': { target: API, changeOrigin: false },
      '/share': { target: API, changeOrigin: false },
      '/health': { target: API, changeOrigin: false },
    },
  },
});
