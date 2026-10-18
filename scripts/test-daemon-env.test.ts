import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** After the v1 flip the daily update check is on by default: a test daemon that lives 10 minutes would fetch the GitHub feed (final review M10). */
const SPAWNERS = [
  "scripts/e2e/daemon.ts",
  "scripts/smoke-lib.ts",
  "apps/daemon/src/security/testing/daemon-process.ts",
];

describe("test daemons never run the daily update check", () => {
  it.each(SPAWNERS)("%s sets PAP_UPDATE_CHECK to 0", (file) => {
    expect(readFileSync(resolve(import.meta.dirname, "..", file), "utf8")).toMatch(/PAP_UPDATE_CHECK: "0"/);
  });
});
