import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  // schema.ts holds the Stage A tables and re-exports one file per Stage B/C module (./src/schema/<module>.ts).
  schema: ['./src/schema.ts', './src/schema/*.ts'],
  out: './drizzle',
  casing: 'snake_case',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/studio_assistant' },
});
