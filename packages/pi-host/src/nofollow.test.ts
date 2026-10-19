import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAt, openDirAt, openRootDir, unlinkAt } from "./nofollow.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-nofollow-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mode = (path: string): number => statSync(path).mode & 0o777;

describe("nofollow helpers", () => {
  it("opens a folder, creates a missing one with the requested mode and reopens an existing one", () => {
    const root = openRootDir(dir);
    const made = openDirAt(root, "a", { create: 0o700 });
    closeSync(made);
    expect(mode(join(dir, "a"))).toBe(0o700);
    closeSync(openDirAt(root, "a"));
    closeSync(root);
  });

  it("does not create a folder when asked only to open", () => {
    const root = openRootDir(dir);
    expect(() => openDirAt(root, "missing")).toThrow(/ENOENT/);
    expect(existsSync(join(dir, "missing"))).toBe(false);
    closeSync(root);
  });

  // Mutant: drop O_NOFOLLOW from openDirAt -> the link to the outside folder is followed (killed here).
  it("refuses a link and a file in place of a folder, also when it would create one", () => {
    mkdirSync(join(dir, "outside"));
    symlinkSync(join(dir, "outside"), join(dir, "link"));
    writeFileSync(join(dir, "file"), "x");
    symlinkSync(join(dir, "nowhere"), join(dir, "dangling"));
    const root = openRootDir(dir);
    for (const name of ["link", "file", "dangling"]) {
      expect(() => openDirAt(root, name, { create: 0o700 })).toThrow(/not a folder|EEXIST/);
    }
    expect(existsSync(join(dir, "nowhere"))).toBe(false);
    closeSync(root);
  });

  it("refuses a root that is a link", () => {
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "root-link"));
    expect(() => openRootDir(join(dir, "root-link"))).toThrow();
  });

  // Mutant: drop O_NOFOLLOW from openAt -> the write lands in the link's target (killed here).
  it("opens a file inside a folder it holds and refuses a link as the last component", () => {
    writeFileSync(join(dir, "target"), "secret");
    symlinkSync(join(dir, "target"), join(dir, "link"));
    const root = openRootDir(dir);
    expect(() => openAt(root, "link", constants.O_RDONLY)).toThrow(/ELOOP/);
    expect(() => openAt(root, "link", constants.O_WRONLY | constants.O_TRUNC)).toThrow(/ELOOP/);
    expect(readFileSync(join(dir, "target"), "utf8")).toBe("secret");
    const fd = openAt(root, "new", constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    closeSync(fd);
    expect(mode(join(dir, "new"))).toBe(0o600);
    closeSync(root);
  });

  // Mutant: resolve the name against the path instead of the descriptor -> the swapped folder is entered (killed here).
  it("keeps working in the folder it opened when a link replaces that folder afterwards", () => {
    mkdirSync(join(dir, "box"));
    mkdirSync(join(dir, "elsewhere"));
    const box = openRootDir(join(dir, "box"));
    renameSync(join(dir, "box"), join(dir, "moved"));
    symlinkSync(join(dir, "elsewhere"), join(dir, "box"));
    closeSync(openAt(box, "inside", constants.O_WRONLY | constants.O_CREAT, 0o600));
    expect(existsSync(join(dir, "moved", "inside"))).toBe(true);
    expect(existsSync(join(dir, "elsewhere", "inside"))).toBe(false);
    closeSync(box);
  });

  // Mutant: accept "..", "." or a name with a slash -> the descriptor no longer bounds the walk (killed here).
  it("accepts one plain name only", () => {
    const root = openRootDir(dir);
    for (const name of ["", ".", "..", "a/b", "/etc", "a\0b"]) {
      expect(() => openAt(root, name, constants.O_RDONLY)).toThrow(/single name/);
      expect(() => openDirAt(root, name)).toThrow(/single name/);
      expect(() => unlinkAt(root, name)).toThrow(/single name/);
    }
    closeSync(root);
  });

  it("unlinks a link itself and never its target", () => {
    writeFileSync(join(dir, "target"), "keep");
    symlinkSync(join(dir, "target"), join(dir, "link"));
    const root = openRootDir(dir);
    unlinkAt(root, "link");
    expect(existsSync(join(dir, "link"))).toBe(false);
    expect(readFileSync(join(dir, "target"), "utf8")).toBe("keep");
    closeSync(root);
  });
});
