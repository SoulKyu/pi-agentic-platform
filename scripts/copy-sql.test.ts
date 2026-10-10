import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copySql } from "./copy-sql.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-copysql-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("copySql", () => {
  it("copies every src/**/migrations/*.sql into dist with the same relative path", () => {
    mkdirSync(join(root, "src/modules/auth/migrations"), { recursive: true });
    writeFileSync(join(root, "src/modules/auth/migrations/202601010000_auth.sql"), "SELECT 1;");
    writeFileSync(join(root, "src/modules/auth/ignored.sql"), "SELECT 2;");
    expect(copySql(root)).toEqual(["modules/auth/migrations/202601010000_auth.sql"]);
    expect(readFileSync(join(root, "dist/modules/auth/migrations/202601010000_auth.sql"), "utf8")).toBe(
      "SELECT 1;",
    );
  });
});
