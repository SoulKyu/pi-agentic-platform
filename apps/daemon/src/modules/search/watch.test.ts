import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fsWatch } from "./watch.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-watch-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("reports a folder that cannot be watched with its code and returns null", () => {
  const codes: string[] = [];
  expect(
    fsWatch(
      join(dir, "missing"),
      () => undefined,
      (code) => codes.push(code),
    ),
  ).toBeNull();
  expect(codes).toEqual(["ENOENT"]);
});

it("reports the names of files created in the folder, and stops after close", async () => {
  const names: Array<string | null> = [];
  const sentinel: Array<string | null> = [];
  const close = fsWatch(
    dir,
    (name) => names.push(name),
    () => undefined,
  );
  const closeSentinel = fsWatch(
    dir,
    (name) => sentinel.push(name),
    () => undefined,
  );
  expect(close).not.toBeNull();
  writeFileSync(join(dir, "a.jsonl"), "x");
  await vi.waitFor(() => expect(names).toContain("a.jsonl"), { timeout: 5_000 });
  close?.();
  const seen = names.length;
  writeFileSync(join(dir, "b.jsonl"), "x");
  // The second watcher is still open: once it has seen the write, the closed one would have too.
  await vi.waitFor(() => expect(sentinel).toContain("b.jsonl"), { timeout: 5_000 });
  closeSentinel?.();
  expect(names).toHaveLength(seen);
});
