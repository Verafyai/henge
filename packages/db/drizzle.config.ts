import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: ['./src/schema.ts', './src/community-schema.ts'],
  out: './drizzle',
  dialect: 'postgresql',
});
