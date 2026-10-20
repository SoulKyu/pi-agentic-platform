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
            "apps/web/sw/*.test.ts",
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
          exclude: ["**/*.kata.int.test.ts", "**/node_modules/**", "**/dist/**"],
          pool: "forks",
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        // AVM-P18: the real Kata stack (KVM, pap-vmd). One file at a time: they share pap0, the ports 7841/7842 and pap-vmd.
        extends: true,
        test: {
          name: "kata",
          environment: "node",
          include: ["{apps,packages}/*/src/**/*.kata.int.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          pool: "forks",
          fileParallelism: false,
          testTimeout: 15 * 60_000,
          hookTimeout: 15 * 60_000,
        },
      },
    ],
  },
});
