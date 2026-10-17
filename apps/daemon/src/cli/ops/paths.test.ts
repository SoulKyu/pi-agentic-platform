import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { acquireInstanceLock } from "../../kernel/home.ts";
import { installRoot, opsDir, readJsonBounded, readLockPid, writeJsonAtomic } from "./paths.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-paths-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const mode = (path: string) => statSync(path).mode & 0o777;

describe("installRoot and opsDir", () => {
  it("are the documented folders", () => {
    expect(installRoot({ homedir: "/home/u" })).toBe("/home/u/.local/share/pap");
    expect(opsDir("/home/u/.pap")).toBe("/home/u/.pap/update");
  });
});

describe("writeJsonAtomic", () => {
  it("creates the parent 0700 and the file 0600 with the value", () => {
    const path = join(dir, "update", "pending.json");
    writeJsonAtomic(path, { step: "stop" });
    expect(mode(join(dir, "update"))).toBe(0o700);
    expect(mode(path)).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ step: "stop" });
    expect(readdirSync(join(dir, "update"))).toEqual(["pending.json"]);
  });
  it("replaces an existing file and keeps the mode 0600", () => {
    const path = join(dir, "x.json");
    writeFileSync(path, "{}", { mode: 0o644 });
    writeJsonAtomic(path, { a: 1 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 1 });
    expect(mode(path)).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });
  it("leaves no .tmp and no folder when JSON.stringify throws (circular value)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const path = join(dir, "new", "x.json");
    expect(() => writeJsonAtomic(path, circular)).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
  it("leaves the previous file intact and no .tmp when the rename fails (target is a folder)", () => {
    const path = join(dir, "x.json");
    mkdirSync(path);
    expect(() => writeJsonAtomic(path, { a: 1 })).toThrow();
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });
});

describe("readJsonBounded", () => {
  const schema = z.object({ n: z.number() }).strict();
  it("is null when absent", () => {
    expect(readJsonBounded(join(dir, "none.json"), schema, 100)).toBeNull();
  });
  it("is the value when it matches", () => {
    const path = join(dir, "x.json");
    writeFileSync(path, '{"n":3}');
    expect(readJsonBounded(path, schema, 100)).toEqual({ n: 3 });
  });
  it.each([
    ["not JSON", "{nope"],
    ["wrong shape", '{"n":"3"}'],
    ["extra key", '{"n":3,"x":1}'],
    ["above the cap", `{"n":3,"pad":"${"x".repeat(200)}"}`],
  ])("is damaged: %s", (_label, text) => {
    const path = join(dir, "x.json");
    writeFileSync(path, text);
    expect(readJsonBounded(path, schema, 100)).toBe("damaged");
  });
  it("a file exactly at the cap is read; one byte more is damaged", () => {
    const path = join(dir, "x.json");
    const text = '{"n":3}';
    writeFileSync(path, text);
    expect(readJsonBounded(path, schema, text.length)).toEqual({ n: 3 });
    expect(readJsonBounded(path, schema, text.length - 1)).toBe("damaged");
  });
  it("a folder in place of the file is damaged", () => {
    mkdirSync(join(dir, "x.json"));
    expect(readJsonBounded(join(dir, "x.json"), schema, 100)).toBe("damaged");
  });
});

describe("readLockPid", () => {
  it("reads the pid acquireInstanceLock wrote", () => {
    const lock = acquireInstanceLock(dir);
    try {
      expect(readLockPid(dir)).toBe(process.pid);
    } finally {
      lock.release();
    }
    expect(readLockPid(dir)).toBeNull();
  });
  it.each(["", "abc\n", "-4\n", "0\n", "1.5\n"])("is null for %j", (text) => {
    writeFileSync(join(dir, "pap.lock"), text);
    expect(readLockPid(dir)).toBeNull();
  });
});
