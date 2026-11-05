import { defineConfig } from 'vitest/config';

// Database tests read DATABASE_URL from .env locally and from the job environment in CI.
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the environment.
}

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts', 'tests/dq/**/*.test.ts'], environment: 'node' } },
      {
        test: {
          name: 'db',
          include: ['tests/db/**/*.test.ts'],
          environment: 'node',
          // Tests share one database, so run files one after another.
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
