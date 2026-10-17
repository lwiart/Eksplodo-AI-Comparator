import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'mysql',
  schema: ['./server/src/db/schema/core.ts', './server/src/db/schema/jobs.ts', './server/src/db/schema/errors.ts', './server/src/db/schema/catalog.ts', './server/src/db/schema/tests.ts', './server/src/db/schema/runs.ts', './server/src/db/schema/sharing.ts'],
  out: './server/drizzle',
});
