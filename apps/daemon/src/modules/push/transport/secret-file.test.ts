import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeExclusive } from "./secret-file.ts";

describe("writeExclusive", () => {
  let dir = "";
  let umask = 0;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pap-secret-file-"));
    umask = process.umask(0);
  });
  afterEach(() => {
    process.umask(umask);
    rmSync(dir, { recursive: true, force: true });
  });

  it("exclusive-never-overwrites", () => {
    const path = join(dir, "key.json");
    expect(writeExclusive(path, "first")).toBe(true);
    expect(writeExclusive(path, "second")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("first");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["key.json"]);
  });
});
