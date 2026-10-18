import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO } from "./release-bed.ts";
import {
  flipTree,
  PI_COMPAT_YML,
  preFlipShape,
  RELEASE_YML,
  UPDATE_CHECK,
  UPDATE_CHECK_TEST,
} from "./release-flip.ts";

/** Everything the shape pins read. A directory is copied whole. */
const READ_BY_THE_PINS = [
  "package.json",
  "apps/daemon/package.json",
  ".release-please-manifest.json",
  "release-please-config.json",
  ".github/workflows",
  "apps/daemon/src/update-check.ts",
  "apps/daemon/src/update-check.test.ts",
  "LICENSE",
  "LICENSES",
  "THIRD_PARTY_NOTICES.md",
  "docs/agents/release.md",
];
/** Every test that pins the shape of a file the flip rewrites. This file is not one of them. */
const SHAPE_PINS = [
  "scripts/ci-config.compat.test.ts",
  "scripts/release-check.test.ts",
  "scripts/release-check.v1.test.ts",
  "scripts/release-flip.test.ts",
];
const CHECKOUT = resolve(import.meta.dirname, "..");

let copy: string;
beforeEach(() => {
  copy = mkdtempSync(join(tmpdir(), "pap-flip-rehearsal-"));
  for (const file of READ_BY_THE_PINS) {
    mkdirSync(dirname(join(copy, file)), { recursive: true });
    cpSync(join(REPO, file), join(copy, file), { recursive: true });
  }
  // The checkout may already be flipped (the owner's flip PR): the rehearsal flips from the pre-flip shape either way.
  for (const file of [RELEASE_YML, PI_COMPAT_YML, UPDATE_CHECK, UPDATE_CHECK_TEST])
    writeFileSync(join(copy, file), preFlipShape(file, readFileSync(join(copy, file), "utf8")));
});
afterEach(() => rmSync(copy, { recursive: true, force: true }));

describe("the v1 flip leaves the pinned shapes green (final review I2)", () => {
  it("every shape pin passes on a flipped copy of the repository files", () => {
    flipTree(copy);
    const vitest = join(CHECKOUT, "node_modules/vitest/vitest.mjs");
    const run = spawnSync(
      process.execPath,
      [vitest, "run", "--project", "unit", "--no-coverage", ...SHAPE_PINS],
      { cwd: CHECKOUT, env: { ...process.env, PAP_FLIP_REPO: copy }, encoding: "utf8", timeout: 120_000 },
    );
    expect(run.stdout + run.stderr).toMatch(/Tests\s+\d+ passed/);
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });
});
