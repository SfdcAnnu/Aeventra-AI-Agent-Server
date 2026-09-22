import { defineConfig } from 'vitest/config';

/**
 * config.ts now REFUSES to load without a PostgreSQL DATABASE_URL, which
 * is the point — the old `file:./synapse.db` default let the server boot
 * without a database and fail later, far from the cause. Tests import
 * modules that import config, so they need one too.
 *
 * This URL is never connected to. Every test that touches the database
 * mocks Prisma; anything that genuinely needed a server would be an
 * integration test, and would name its own.
 */
export default defineConfig({
  test: {
    env: {
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
    },
  },
});
