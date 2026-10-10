import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["development"] },
  ssr: { resolve: { conditions: ["development"] } },
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    execArgv: ["--disable-warning=ExperimentalWarning"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: [
            "{apps,packages}/*/src/**/*.test.{ts,tsx}",
            "eslint/**/*.test.js",
            "scripts/**/*.test.ts",
          ],
          exclude: ["**/*.int.test.ts", "**/node_modules/**", "**/dist/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["{apps,packages}/*/src/**/*.int.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          pool: "forks",
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
