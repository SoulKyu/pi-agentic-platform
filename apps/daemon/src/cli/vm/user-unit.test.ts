import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_UNIT_BYTES, readUserUnitText } from "./user-unit.ts";

/*
 * Mutants (N5), run for real: O_NOFOLLOW dropped ("a link"); O_NONBLOCK dropped ("a FIFO": the open would hang, the test times
 * out); the type check dropped ("a folder"); the size cap dropped ("a file over the cap").
 */
let home: string;
const unit = () => join(home, ".config", "systemd", "user", "pap.service");
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pap-user-unit-"));
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("readUserUnitText", () => {
  it("reads a regular file", () => {
    writeFileSync(unit(), "[Service]\nEnvironment=PAP_HOME=/x\n");
    expect(readUserUnitText(home)).toBe("[Service]\nEnvironment=PAP_HOME=/x\n");
  });

  it("answers null for a missing file, a link, a FIFO, a folder and a file over the cap", () => {
    expect(readUserUnitText(home)).toBeNull();
    writeFileSync(join(home, "target"), "[Service]\n");
    symlinkSync(join(home, "target"), unit());
    expect(readUserUnitText(home)).toBeNull();
    rmSync(unit());
    execFileSync("mkfifo", [unit()]);
    expect(readUserUnitText(home)).toBeNull();
    rmSync(unit());
    mkdirSync(unit());
    expect(readUserUnitText(home)).toBeNull();
    rmSync(unit(), { recursive: true });
    writeFileSync(unit(), "a".repeat(MAX_UNIT_BYTES + 1));
    expect(readUserUnitText(home)).toBeNull();
    writeFileSync(unit(), "a".repeat(MAX_UNIT_BYTES));
    expect(readUserUnitText(home)).toHaveLength(MAX_UNIT_BYTES);
  });
});
