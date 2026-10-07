import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig, defineProject } from "vitest/config";

const isCI = !!process.env.CI;

const unitInclude = ["app/**/*.test.ts", "app/**/*.test.tsx"];

const integrationInclude = ["app/**/*.integration.test.ts"];

const typesInclude = ["app/lib/db/__tests__/*.test-d.ts"];

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    // Cap concurrent forks: each integration file spawns a fresh PGlite
    // (WASM Postgres) and replays migrations in beforeAll, so CPU-count
    // parallelism saturates I/O and cascades into hook timeout failures.
    maxWorkers: isCI ? 1 : 4,
    projects: [
      defineProject({
        plugins: [tsconfigPaths()],
        test: {
          name: "unit",
          environment: "happy-dom",
          globals: true,
          setupFiles: ["./app/test/setup.ts"],
          include: unitInclude,
          exclude: ["**/*.integration.test.ts"],
        },
      }),
      defineProject({
        plugins: [tsconfigPaths()],
        test: {
          name: "integration",
          environment: "happy-dom",
          globals: true,
          setupFiles: ["./app/test/setup.ts"],
          include: integrationInclude,
          hookTimeout: 30_000,
          testTimeout: 30_000,
        },
      }),
      defineProject({
        plugins: [tsconfigPaths()],
        test: {
          name: "types",
          include: typesInclude,
          typecheck: {
            enabled: true,
            only: true,
            include: typesInclude,
          },
        },
      }),
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["app/lib/**"],
      exclude: [
        "app/lib/storage/adapter.ts",
        "app/lib/db/client.server.ts",
        "app/lib/oauth/types.ts",
      ],
      thresholds: {
        lines: 80,
        branches: 79,
        functions: 80,
      },
    },
  },
});
