import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'mysql',
  schema: ['./server/src/db/schema/core.ts', './server/src/db/schema/jobs.ts', './server/src/db/schema/errors.ts'],
  out: './server/drizzle',
});
