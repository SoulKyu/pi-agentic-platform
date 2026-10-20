import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPiAuth } from "./pi-auth-values.ts";

/*
 * Mutants (RT-43), each run for real in the T15b fix report:
 *  - M-precheck: assertReadable is not called -> the "damaged file" case does not reject.
 *  - M-isfile: the isFile() check is removed -> the FIFO and folder cases fail.
 *  - M-cap: the byte cap is removed -> the oversized case fails.
 *  - M-bom: the BOM is not stripped -> "a BOM-prefixed file" fails.
 *  - M-raw-syntax: the SyntaxError is rethrown -> the message case fails.
 */
const KEY = `sk-test-${"A".repeat(24)}`;
let dir: string;
const auth = () => join(dir, "auth.json");
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-t15b-auth-"));
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const message = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error as Error).message,
  );

describe("the auth.json pre-check (m4)", () => {
  it("reads a missing file as no credential", async () => {
    await expect(readPiAuth(dir)).resolves.toEqual({ providers: [], values: [] });
  });

  it("reads a BOM-prefixed file", async () => {
    writeFileSync(auth(), `\uFEFF${JSON.stringify({ a: { type: "api_key", key: KEY } })}`);
    expect((await readPiAuth(dir)).values).toContain(KEY);
  });

  it("throws a fixed message that holds no text of the file for a damaged one", async () => {
    writeFileSync(auth(), `{"a": ${KEY} oops`);
    expect(await message(readPiAuth(dir))).toBe("auth.json is not JSON");
  });

  it.each([
    ["an array", "[]", "auth.json is not an object"],
    ["a string", '"x"', "auth.json is not an object"],
  ])("refuses %s", async (_name, text, expected) => {
    writeFileSync(auth(), text);
    expect(await message(readPiAuth(dir))).toBe(expected);
  });

  it("refuses a file above the byte cap, and does not read it whole", async () => {
    writeFileSync(auth(), `{"a": "${"x".repeat(4 * 1024 * 1024)}"}`);
    expect(await message(readPiAuth(dir))).toBe("auth.json is too large to scan");
  });

  it("refuses a FIFO without waiting for a writer", async () => {
    execFileSync("mkfifo", [auth()]);
    expect(await message(readPiAuth(dir))).toBe("auth.json is not a regular file");
  });

  it("refuses a folder", async () => {
    mkdirSync(auth());
    expect(await message(readPiAuth(dir))).toBe("auth.json is not a regular file");
  });
});
