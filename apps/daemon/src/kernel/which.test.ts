import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative as relativePath } from "node:path";
import { describe, expect, it } from "vitest";
import { execFileCode, execFileText, whichOnPath } from "./which.ts";

describe("whichOnPath", () => {
  it("finds an executable on PATH and returns null for a miss", () => {
    expect(whichOnPath("sh", { PATH: "/nope:/bin:/usr/bin" })).toMatch(/\/sh$/);
    expect(whichOnPath("pap-no-such-command", { PATH: "/bin" })).toBeNull();
    expect(whichOnPath("sh", {})).toBeNull();
  });

  it("ignores relative PATH entries, which would resolve against the working directory (R130)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pap-which-"));
    try {
      writeFileSync(join(dir, "pap-here"), "#!/bin/sh\n");
      chmodSync(join(dir, "pap-here"), 0o755);
      const relative = relativePath(process.cwd(), dir);
      expect(relative.startsWith("..")).toBe(true);
      expect(whichOnPath("pap-here", { PATH: `${relative}:.` })).toBeNull();
      expect(whichOnPath("pap-here", { PATH: `${relative}:${dir}` })).toBe(join(dir, "pap-here"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("execFileText", () => {
  it("returns the exit code and the output", async () => {
    expect(await execFileText("sh", ["-c", "echo hi"], 2000)).toEqual({ code: 0, stdout: "hi\n" });
    expect((await execFileText("false", [], 2000)).code).toBe(1);
  });

  it("rejects when the program cannot run or does not finish in time, unlike an exit code", async () => {
    await expect(execFileText("/nonexistent", [], 2000)).rejects.toThrow();
    await expect(execFileText("sleep", ["5"], 50)).rejects.toThrow(/timed out/);
  });
});
