import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execFileCode, whichOnPath } from "./which.ts";

describe("whichOnPath", () => {
  it("finds an executable on PATH and returns null for a miss", () => {
    expect(whichOnPath("sh", { PATH: "/nope:/bin:/usr/bin" })).toMatch(/\/sh$/);
    expect(whichOnPath("pap-no-such-command", { PATH: "/bin" })).toBeNull();
    expect(whichOnPath("sh", {})).toBeNull();
  });

  it("skips a file that is not executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "pap-which-"));
    try {
      writeFileSync(join(dir, "pap-plain"), "#!/bin/sh\n");
      chmodSync(join(dir, "pap-plain"), 0o644);
      expect(whichOnPath("pap-plain", { PATH: dir })).toBeNull();
      chmodSync(join(dir, "pap-plain"), 0o755);
      expect(whichOnPath("pap-plain", { PATH: dir })).toBe(join(dir, "pap-plain"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("execFileCode", () => {
  it("returns the exit code, or null when the program cannot run", () => {
    expect(execFileCode("true", [], 2000)).toBe(0);
    expect(execFileCode("false", [], 2000)).toBe(1);
    expect(execFileCode("/nonexistent", [], 2000)).toBeNull();
  });
});
