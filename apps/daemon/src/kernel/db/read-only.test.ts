import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.ts";
import { isReadOnlyError } from "./read-only.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("isReadOnlyError", () => {
  it("recognises the error SQLite raises for a write on a read-only database", () => {
    dir = mkdtempSync(join(tmpdir(), "pap-ro-"));
    const path = join(dir, "s.db");
    const writer = openDatabase(path);
    writer.exec("CREATE TABLE t (a INTEGER)");
    writer.close();
    const reader = openDatabase(path, { readOnly: true });
    let caught: unknown;
    try {
      reader.run("INSERT INTO t (a) VALUES (1)");
    } catch (error) {
      caught = error;
    }
    reader.close();
    expect(isReadOnlyError(caught)).toBe(true);
  });

  it("is false for every other failure", () => {
    expect(isReadOnlyError(new Error("disk full"))).toBe(false);
    expect(isReadOnlyError("attempt to write a readonly database")).toBe(false);
    expect(isReadOnlyError(null)).toBe(false);
  });
});
