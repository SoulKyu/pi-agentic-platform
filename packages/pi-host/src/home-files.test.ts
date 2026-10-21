import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHomeFiles } from "./home-files.ts";

/*
 * Mutants (AVM2-E8), each reverted for real and killed by the named case:
 *  H1 a parent folder is opened by its path, so a link is followed (no O_NOFOLLOW per parent)
 *       -> "symlinked parent" and "remove through a symlinked parent"
 *  H2 the temporary file is opened without O_EXCL / O_NOFOLLOW (a link planted at its name is written through)
 *       -> "never writes through a link planted at the temporary name"
 *  H3 the worker trusts the path from the wire (no AgentFilePath re-validation)
 *       -> "refuses a path the contract would refuse"
 */

const ID = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
let dir: string;
let home: string;
let outside: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-home-"));
  home = join(dir, "home");
  outside = join(dir, "outside");
  mkdirSync(home);
  mkdirSync(outside);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (
  path: string,
  text: string,
  over: Partial<Parameters<ReturnType<typeof createHomeFiles>["put"]>[0]> = {},
) =>
  ({
    type: "home_put",
    id: ID,
    path,
    offset: 0,
    data: Buffer.from(text).toString("base64"),
    last: true,
    ...over,
  }) as const;
const mode = (path: string): number => statSync(path).mode & 0o777;

describe("createHomeFiles put", () => {
  it("creates the parent folders at 0700 and the file at 0600", async () => {
    const result = await createHomeFiles(home).put(put(".kube/cfg/config", "token"));
    expect(result).toEqual({ type: "home_result", id: ID, ok: true });
    expect(readFileSync(join(home, ".kube/cfg/config"), "utf8")).toBe("token");
    expect(mode(join(home, ".kube/cfg/config"))).toBe(0o600);
    expect(mode(join(home, ".kube"))).toBe(0o700);
    expect(mode(join(home, ".kube/cfg"))).toBe(0o700);
    expect(readdirSync(join(home, ".kube/cfg"))).toEqual(["config"]);
  });

  it("replaces a file that exists (temp file, then rename)", async () => {
    const files = createHomeFiles(home);
    await files.put(put("a.txt", "one"));
    const first = statSync(join(home, "a.txt")).ino;
    expect((await files.put(put("a.txt", "two", { id: OTHER }))).ok).toBe(true);
    expect(readFileSync(join(home, "a.txt"), "utf8")).toBe("two");
    expect(statSync(join(home, "a.txt")).ino).not.toBe(first);
    expect(readdirSync(home)).toEqual(["a.txt"]);
  });

  it("assembles chunks in order and refuses one out of order", async () => {
    const files = createHomeFiles(home);
    expect((await files.put(put("c", "ab", { last: false }))).ok).toBe(true);
    expect(await files.put(put("c", "cd", { offset: 5, last: true }))).toEqual({
      type: "home_result",
      id: ID,
      ok: false,
      code: "order",
    });
    expect(readdirSync(home)).toEqual([]);
    await files.put(put("c", "ab", { last: false }));
    expect((await files.put(put("c", "cd", { offset: 2 }))).ok).toBe(true);
    expect(readFileSync(join(home, "c"), "utf8")).toBe("abcd");
  });

  it("answers too_large past one file's limit and leaves no part behind", async () => {
    const files = createHomeFiles(home);
    const big = Buffer.alloc(1_048_577).toString("base64");
    expect(await files.put(put("big", "", { data: big }))).toMatchObject({ ok: false, code: "too_large" });
    expect(readdirSync(home)).toEqual([]);
  });

  it("symlinked parent: the write fails and nothing lands outside the home", async () => {
    symlinkSync(outside, join(home, ".kube"));
    const result = await createHomeFiles(home).put(put(".kube/config", "stolen"));
    expect(result).toMatchObject({ ok: false, code: "write_failed" });
    expect(readdirSync(outside)).toEqual([]);
  });

  it("a symlinked deeper parent fails the same way", async () => {
    mkdirSync(join(home, "a"));
    symlinkSync(outside, join(home, "a", "b"));
    expect(await createHomeFiles(home).put(put("a/b/c/config", "x"))).toMatchObject({ ok: false });
    expect(readdirSync(outside)).toEqual([]);
  });

  it("never writes through a link planted at the temporary name", async () => {
    const target = join(outside, "victim");
    writeFileSync(target, "keep");
    symlinkSync(target, join(home, `.${ID}.part`));
    expect(await createHomeFiles(home).put(put("config", "evil"))).toMatchObject({
      ok: false,
      code: "write_failed",
    });
    expect(readFileSync(target, "utf8")).toBe("keep");
  });

  it("replaces a link planted at the final name without touching its target", async () => {
    const target = join(outside, "victim");
    writeFileSync(target, "keep");
    symlinkSync(target, join(home, "config"));
    expect((await createHomeFiles(home).put(put("config", "mine"))).ok).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("keep");
    expect(readFileSync(join(home, "config"), "utf8")).toBe("mine");
    expect(statSync(join(home, "config")).isFile()).toBe(true);
  });

  it.each(["../escape", "/etc/passwd", "a//b", "a b", "a/./b", "café", "", "a/b/c/d/e/f/g/h/i"])(
    "refuses a path the contract would refuse: %j",
    async (path) => {
      expect(await createHomeFiles(home).put(put(path, "x"))).toMatchObject({
        ok: false,
        code: "write_failed",
      });
      expect(readdirSync(home)).toEqual([]);
      expect(readdirSync(dir).sort()).toEqual(["home", "outside"]);
    },
  );

  it("a failed put leaves the folder usable for the next one", async () => {
    const files = createHomeFiles(home);
    await files.put(put("x", "abc", { last: false }));
    await files.put(put("x", "abc", { offset: 9 }));
    expect((await files.put(put("y", "ok", { id: OTHER }))).ok).toBe(true);
    expect(existsSync(join(home, "y"))).toBe(true);
  });
});

describe("createHomeFiles remove", () => {
  const rm = (path: string) => ({ type: "home_remove", id: ID, path }) as const;

  it("deletes the file", async () => {
    const files = createHomeFiles(home);
    await files.put(put("a/b", "x"));
    expect((await files.remove(rm("a/b"))).ok).toBe(true);
    expect(existsSync(join(home, "a/b"))).toBe(false);
  });

  it("a missing path is ok, a missing parent too", async () => {
    const files = createHomeFiles(home);
    expect((await files.remove(rm("nothing"))).ok).toBe(true);
    expect((await files.remove(rm("no/such/dir/file"))).ok).toBe(true);
  });

  it("remove through a symlinked parent deletes nothing outside", async () => {
    writeFileSync(join(outside, "config"), "keep");
    symlinkSync(outside, join(home, ".kube"));
    expect(await createHomeFiles(home).remove(rm(".kube/config"))).toMatchObject({
      ok: false,
      code: "write_failed",
    });
    expect(readFileSync(join(outside, "config"), "utf8")).toBe("keep");
  });

  it("removes a link at the final name, not its target", async () => {
    writeFileSync(join(outside, "victim"), "keep");
    symlinkSync(join(outside, "victim"), join(home, "config"));
    expect((await createHomeFiles(home).remove(rm("config"))).ok).toBe(true);
    expect(readFileSync(join(outside, "victim"), "utf8")).toBe("keep");
    expect(readdirSync(home)).toEqual([]);
  });

  it("refuses a path the contract would refuse", async () => {
    writeFileSync(join(dir, "top"), "keep");
    expect(await createHomeFiles(home).remove(rm("../top"))).toMatchObject({
      ok: false,
      code: "write_failed",
    });
    expect(existsSync(join(dir, "top"))).toBe(true);
  });
});
