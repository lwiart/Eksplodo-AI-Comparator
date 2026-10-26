import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    maxWorkers: 4, // la machine de dev manque de mémoire avec le nombre de workers par défaut
    // Couverture du code (activée par `npm test`, pas par un `npx vitest run` ciblé) : synthèse affichée en fin de
    // lancement, rapport détaillé fichier par fichier dans coverage/index.html.
    coverage: {
      provider: 'v8',
      include: ['server/src/**', 'web/src/**'],
      exclude: ['**/*.test.*', 'web/src/test-setup.ts'],
      reporter: ['text-summary', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
    },
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['server/test/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['web/src/**/*.test.{ts,tsx}'],
          setupFiles: ['web/src/test-setup.ts'],
        },
      },
    ],
  },
});
