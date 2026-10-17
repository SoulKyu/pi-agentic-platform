import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPending, pendingPath, readPending, writePending, type Pending } from "./pending.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pap-pending-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const sample: Pending = {
  format: 1,
  from: "r1",
  to: "r2",
  step: "stopping",
  snapshot: null,
  schemaBefore: ["001", "002"],
  startedAt: "2026-10-17T10:00:00.000Z",
};

function raw(value: unknown): void {
  mkdirSync(join(home, "update"), { recursive: true });
  writeFileSync(pendingPath(home), typeof value === "string" ? value : JSON.stringify(value));
}

describe("pending.json", () => {
  it("is null when absent", () => {
    expect(readPending(home)).toBeNull();
  });

  it("round-trips with file 0600 and folder 0700, and leaves no temp file", () => {
    writePending(home, sample);
    expect(readPending(home)).toEqual(sample);
    expect(statSync(pendingPath(home)).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "update")).mode & 0o777).toBe(0o700);
    writePending(home, { ...sample, step: "switched", snapshot: "pre-update-r2-2026.db" });
    expect(readPending(home)).toMatchObject({ step: "switched", snapshot: "pre-update-r2-2026.db" });
  });

  it("refuses to write something that is not the shape", () => {
    expect(() => writePending(home, { ...sample, to: "a/b" })).toThrow();
    expect(readPending(home)).toBeNull();
  });

  it.each([
    ["an extra key", { ...sample, extra: 1 }],
    ["a bad snapshot name", { ...sample, snapshot: "../evil.db" }],
    ["a snapshot without the prefix", { ...sample, snapshot: "state.db" }],
    ["a `to` with a slash", { ...sample, to: "a/b" }],
    ["a bad step", { ...sample, step: "done" }],
    ["a bad date", { ...sample, startedAt: "yesterday" }],
    ["`from` is a dot", { ...sample, from: "." }],
    ["`to` is two dots", { ...sample, to: ".." }],
    ["another format", { ...sample, format: 2 }],
  ])("reports %s as damaged", (_name, value) => {
    raw(value);
    expect(readPending(home)).toBe("damaged");
  });

  it("reports text that is not JSON, and a 100 KB file, as damaged", () => {
    raw("{nope");
    expect(readPending(home)).toBe("damaged");
    raw(
      JSON.stringify({
        ...sample,
        schemaBefore: ["x".repeat(100)].concat(Array(1000).fill("y".repeat(100))),
      }),
    );
    expect(statSync(pendingPath(home)).size).toBeGreaterThan(64 * 1024);
    expect(readPending(home)).toBe("damaged");
  });

  it("a failed write leaves no temp file behind", () => {
    mkdirSync(pendingPath(home), { recursive: true }); // rename onto a folder fails
    expect(() => writePending(home, sample)).toThrow();
    expect(readdirSync(join(home, "update")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("reports a folder in place of the file as damaged, not absent", () => {
    mkdirSync(pendingPath(home), { recursive: true });
    expect(readPending(home)).toBe("damaged");
  });

  it("clearPending is idempotent", () => {
    writePending(home, sample);
    clearPending(home);
    clearPending(home);
    expect(readPending(home)).toBeNull();
  });
});
