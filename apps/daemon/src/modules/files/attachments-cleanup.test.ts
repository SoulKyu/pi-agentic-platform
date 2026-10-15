import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLEANUP_MAX_FOLDERS, cleanupAttachments } from "./attachments-cleanup.ts";

let dir: string;
let root: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-cleanup-"));
  root = join(dir, "attachments");
  mkdirSync(root);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const folder = (id = randomUUID(), file = "a.png") => {
  mkdirSync(join(root, id));
  writeFileSync(join(root, id, file), "x");
  return id;
};
const all = () => true;

describe("cleanupAttachments", () => {
  it("removes the expired session folders and counts them", async () => {
    const a = folder();
    const b = folder();
    expect(await cleanupAttachments(root, all)).toEqual({ removed: 2, kept: 0, more: false });
    expect(existsSync(join(root, a))).toBe(false);
    expect(existsSync(join(root, b))).toBe(false);
  });

  it("asks only about session-shaped folders, and keeps a fresh one", async () => {
    const fresh = folder();
    const old = folder();
    const asked: string[] = [];
    const result = await cleanupAttachments(root, (id) => (asked.push(id), id === old));
    expect(result).toMatchObject({ removed: 1, kept: 1 });
    expect(existsSync(join(root, fresh))).toBe(true);
    expect(asked.sort()).toEqual([fresh, old].sort());
  });

  it("keeps a session-named link to a folder outside, a session-named file, pending/ and other names", async () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "x");
    const linked = randomUUID();
    symlinkSync(outside, join(root, linked));
    const plainFile = randomUUID();
    writeFileSync(join(root, plainFile), "x");
    mkdirSync(join(root, "pending"));
    writeFileSync(join(root, "pending", "p.png"), "x");
    mkdirSync(join(root, "not-a-session"));
    mkdirSync(join(root, randomUUID().toUpperCase()));
    const result = await cleanupAttachments(root, all);
    expect(result).toEqual({ removed: 0, kept: 5, more: false });
    expect(readdirSync(outside)).toEqual(["keep.txt"]);
    expect(existsSync(join(root, linked))).toBe(true);
    expect(existsSync(join(root, plainFile))).toBe(true);
    expect(existsSync(join(root, "pending", "p.png"))).toBe(true);
    expect(existsSync(join(root, "not-a-session"))).toBe(true);
  });

  it("unlinks a link inside a removed folder and leaves its target intact", async () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "x");
    const id = folder();
    symlinkSync(outside, join(root, id, "escape"));
    expect(await cleanupAttachments(root, all)).toMatchObject({ removed: 1 });
    expect(existsSync(join(root, id))).toBe(false);
    expect(readdirSync(outside)).toEqual(["keep.txt"]);
  });

  it("does nothing when the root is a link or missing", async () => {
    const real = join(dir, "real");
    mkdirSync(real);
    const id = randomUUID();
    mkdirSync(join(real, id));
    const link = join(dir, "link");
    symlinkSync(real, link);
    expect(await cleanupAttachments(link, all)).toEqual({ removed: 0, kept: 0, more: false });
    expect(existsSync(join(real, id))).toBe(true);
    expect(await cleanupAttachments(join(dir, "missing"), all)).toEqual({ removed: 0, kept: 0, more: false });
  });

  it("removes 50 a pass: 120 expired folders end in 50, 50 and 20", async () => {
    for (let i = 0; i < 120; i++) folder();
    const first = await cleanupAttachments(root, all);
    expect(first).toMatchObject({ removed: CLEANUP_MAX_FOLDERS, more: true });
    const second = await cleanupAttachments(root, all);
    expect(second).toMatchObject({ removed: 50, more: true });
    const third = await cleanupAttachments(root, all);
    expect(third).toEqual({ removed: 20, kept: 0, more: false });
    expect(readdirSync(root)).toEqual([]);
  });

  it("keeps what is not expired while it walks on", async () => {
    const keep = folder();
    for (let i = 0; i < 3; i++) folder();
    const result = await cleanupAttachments(root, (id) => id !== keep);
    expect(result).toEqual({ removed: 3, kept: 1, more: false });
    expect(readdirSync(root)).toEqual([keep]);
  });
});
