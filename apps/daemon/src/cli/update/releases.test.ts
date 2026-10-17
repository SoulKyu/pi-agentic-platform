import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkedId,
  otherReleases,
  readCurrent,
  releaseDir,
  releaseIsComplete,
  switchCurrent,
} from "./releases.ts";

const fsSpy = vi.hoisted(() => ({ renames: [] as { from: string; to: string }[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      fsSpy.renames.push({ from: String(from), to: String(to) });
      return actual.renameSync(from, to);
    },
  };
});

let app: string;
beforeEach(() => {
  app = mkdtempSync(join(tmpdir(), "pap-releases-"));
  fsSpy.renames.length = 0;
});
afterEach(() => rmSync(app, { recursive: true, force: true }));

function release(id: string, builtAt?: string, complete = true): void {
  const dir = join(app, "releases", id);
  if (complete) {
    mkdirSync(join(dir, "node", "bin"), { recursive: true });
    mkdirSync(join(dir, "app", "apps", "daemon", "dist"), { recursive: true });
    writeFileSync(join(dir, "node", "bin", "node"), "#!/bin/sh\n");
    chmodSync(join(dir, "node", "bin", "node"), 0o755);
    writeFileSync(join(dir, "app", "apps", "daemon", "dist", "main.js"), "");
  } else mkdirSync(dir, { recursive: true });
  if (builtAt !== undefined) writeFileSync(join(dir, "BUILD_INFO.json"), JSON.stringify({ builtAt }));
}

describe("ids", () => {
  it("accepts the release id class and refuses ., .., separators and the rest", () => {
    expect(checkedId("1.2.3-next.4_x")).toBe("1.2.3-next.4_x");
    for (const bad of [".", "..", "a/b", "../x", "", "a b", "a\n", "x".repeat(65), "a\\b"])
      expect(() => checkedId(bad), JSON.stringify(bad)).toThrow("invalid release id");
    expect(() => releaseDir(app, "..")).toThrow("invalid release id");
    expect(releaseDir(app, "r1")).toBe(join(app, "releases", "r1"));
  });
});

describe("readCurrent", () => {
  it("reads only releases/<id>", () => {
    expect(readCurrent(app)).toBeNull();
    symlinkSync("releases/r1", join(app, "current"));
    expect(readCurrent(app)).toBe("r1");
  });
  it.each(["/etc", "../x", "releases/..", "releases/.", "/abs/releases/r1", "releases/a/b", "r1"])(
    "rejects the target %s",
    (target) => {
      symlinkSync(target, join(app, "current"));
      expect(readCurrent(app)).toBeNull();
    },
  );
  it("rejects a regular file", () => {
    writeFileSync(join(app, "current"), "releases/r1");
    expect(readCurrent(app)).toBeNull();
  });
});

describe("releaseIsComplete / switchCurrent", () => {
  it("needs the node binary and the daemon entry as regular files", () => {
    release("ok");
    release("half", undefined, false);
    expect(releaseIsComplete(app, "ok")).toBe(true);
    expect(releaseIsComplete(app, "half")).toBe(false);
    expect(releaseIsComplete(app, "missing")).toBe(false);
    expect(() => releaseIsComplete(app, "..")).toThrow("invalid release id");
  });

  it("switches with a relative link and rename, leaving no current.new file", () => {
    release("a");
    release("b");
    switchCurrent(app, "a");
    expect(readlinkSync(join(app, "current"))).toBe("releases/a");
    switchCurrent(app, "b");
    expect(readlinkSync(join(app, "current"))).toBe("releases/b");
    expect(readdirSync(app).filter((name) => name.startsWith("current.new"))).toEqual([]);
    const last = fsSpy.renames.at(-1);
    expect(last?.to).toBe(join(app, "current"));
    expect(last?.from.startsWith(join(app, "current.new."))).toBe(true);
  });

  it("refuses an incomplete release and leaves current unchanged", () => {
    release("a");
    release("half", undefined, false);
    switchCurrent(app, "a");
    expect(() => switchCurrent(app, "half")).toThrow("release half is incomplete");
    expect(() => switchCurrent(app, "..")).toThrow("invalid release id");
    expect(readCurrent(app)).toBe("a");
    expect(readdirSync(app).filter((name) => name.startsWith("current.new"))).toEqual([]);
  });

  it("removes its temp link when the rename fails", () => {
    release("a");
    mkdirSync(join(app, "current")); // a folder cannot be replaced by rename(2) of a link
    mkdirSync(join(app, "current", "keep"));
    expect(() => switchCurrent(app, "a")).toThrow();
    expect(readdirSync(app).filter((name) => name.startsWith("current.new"))).toEqual([]);
  });
});

describe("otherReleases", () => {
  it("is empty without a releases folder", () => {
    expect(otherReleases(app, null)).toEqual([]);
  });

  it("orders by builtAt newest first, skips stage folders, a symlinked folder, an incomplete one and `skip`", () => {
    release("old", "2026-01-01T00:00:00.000Z");
    release("new", "2026-03-01T00:00:00.000Z");
    release("mid", "2026-02-01T00:00:00.000Z");
    release("nodate");
    release("cur", "2026-04-01T00:00:00.000Z");
    release(".stage.123", "2026-05-01T00:00:00.000Z");
    release("half", "2026-06-01T00:00:00.000Z", false);
    symlinkSync("old", join(app, "releases", "linked"));
    expect(lstatSync(join(app, "releases", "linked")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(app, "releases", "linked", "app"))).toBe(true);
    expect(otherReleases(app, "cur")).toEqual(["new", "mid", "old", "nodate"]);
    expect(otherReleases(app, null)).toEqual(["cur", "new", "mid", "old", "nodate"]);
  });
});
