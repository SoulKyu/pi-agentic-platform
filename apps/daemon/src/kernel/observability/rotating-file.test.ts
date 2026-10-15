import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRotatingFile } from "./rotating-file.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-rotating-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("createRotatingFile", () => {
  it("appends one line per call in a 0600 file", () => {
    const path = join(dir, "runs.jsonl");
    const file = createRotatingFile({ path });
    file.append('{"a":1}');
    file.append('{"a":2}');
    file.close();
    expect(readFileSync(path, "utf8")).toBe('{"a":1}\n{"a":2}\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("rotates at the size limit to .1 and keeps at most nine, dropping the oldest", () => {
    const path = join(dir, "runs.jsonl");
    const file = createRotatingFile({ path, maxBytes: 20, keep: 9 });
    // Each line is 10 bytes with its newline: two fit, the third rotates.
    for (let n = 0; n < 22; n++) file.append(`line-${String(n).padStart(4, "0")}`.slice(0, 9));
    file.close();
    for (let n = 1; n <= 9; n++) expect(existsSync(`${path}.${n}`)).toBe(true);
    expect(existsSync(`${path}.10`)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("line-0020\nline-0021\n");
    expect(readFileSync(`${path}.1`, "utf8")).toBe("line-0018\nline-0019\n");
    expect(readFileSync(`${path}.9`, "utf8")).toBe("line-0002\nline-0003\n");
    expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600);
  });

  it("continues the size of a file that already exists", () => {
    const path = join(dir, "runs.jsonl");
    writeFileSync(path, "x".repeat(15) + "\n", { mode: 0o600 });
    const file = createRotatingFile({ path, maxBytes: 20 });
    file.append("0123456789");
    file.close();
    expect(readFileSync(`${path}.1`, "utf8")).toBe("x".repeat(15) + "\n");
    expect(readFileSync(path, "utf8")).toBe("0123456789\n");
  });

  it("never follows a symlink at the path", () => {
    const target = join(dir, "target");
    writeFileSync(target, "keep\n");
    const path = join(dir, "runs.jsonl");
    symlinkSync(target, path);
    const file = createRotatingFile({ path });
    expect(() => file.append("x")).toThrow();
    expect(readFileSync(target, "utf8")).toBe("keep\n");
  });

  it("drops and counts a line over 16 KiB and a line holding a line break", () => {
    const path = join(dir, "runs.jsonl");
    const file = createRotatingFile({ path });
    file.append("a".repeat(16 * 1024 + 1));
    file.append("two\nlines");
    file.append("carriage\rreturn");
    file.append("a".repeat(16 * 1024));
    file.close();
    expect(file.dropped()).toBe(3);
    expect(readFileSync(path, "utf8")).toBe("a".repeat(16 * 1024) + "\n");
  });
});
