import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSessionCwd } from "./cwd.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-cwd-"));
  mkdirSync(join(root, "proj"));
  writeFileSync(join(root, "file.txt"), "x");
  symlinkSync(join(root, "proj"), join(root, "link"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const codeOf = (input: string) => {
  try {
    resolveSessionCwd(input);
    return null;
  } catch (error) {
    return (error as PapError).code;
  }
};

describe("resolveSessionCwd", () => {
  it.each([
    ["relative path", "proj"],
    ["tilde path", "~/proj"],
    ["missing folder", "/definitely/missing/pap-folder"],
    ["empty", ""],
    ["NUL byte", "/tmp/a\0b"],
  ])("rejects a %s with invalid_cwd", (_label, input) => {
    expect(codeOf(input)).toBe("invalid_cwd");
  });

  it("rejects a file with invalid_cwd", () => {
    expect(codeOf(join(root, "file.txt"))).toBe("invalid_cwd");
  });

  it("resolves a symlink to the real folder", () => {
    expect(resolveSessionCwd(join(root, "link"))).toBe(realpathSync(join(root, "proj")));
  });
});
