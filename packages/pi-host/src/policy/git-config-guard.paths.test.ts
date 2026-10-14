import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLEAN, checker, DIRTY, gitDir, repo, tempRoot } from "./git-config-guard.fixtures.ts";
import { GIT_RUNS_PROGRAM, GIT_UNREADABLE, MAX_GIT_DIR_ENTRIES } from "./git-config-guard.ts";

let root: string;
let home: string;
beforeEach(() => {
  ({ root, home } = tempRoot());
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const check = (start: string) => checker(home)(start);

describe("the object format (MC10, N2)", () => {
  it.each(["sha256", "SHA256", "other", ""])("asks for extensions.objectFormat = %j", async (format) => {
    const top = repo(join(root, "r"), `${CLEAN}[extensions]\n\tobjectFormat = ${format}\n`);
    expect(await check(top)).toBe(GIT_UNREADABLE);
  });
  it("asks for a bare extensions.objectFormat and for compatObjectFormat", async () => {
    expect(await check(repo(join(root, "a"), `${CLEAN}[extensions]\n\tobjectFormat\n`))).toBe(GIT_UNREADABLE);
    expect(await check(repo(join(root, "b"), `${CLEAN}[extensions]\n\tcompatObjectFormat = sha256\n`))).toBe(
      GIT_UNREADABLE,
    );
  });
  it.each(["sha1", "SHA1"])("allows extensions.objectFormat = %s", async (format) => {
    const top = repo(join(root, "r"), `${CLEAN}[extensions]\n\tobjectFormat = ${format}\n`);
    expect(await check(top)).toBeNull();
  });
  it("asks when an include sets it", async () => {
    const top = repo(join(root, "r"), `${CLEAN}[include]\n\tpath = ../fmt.cfg\n`);
    writeFileSync(join(top, "fmt.cfg"), "[extensions]\n\tobjectformat = sha256\n");
    expect(await check(top)).toBe(GIT_UNREADABLE);
  });
  it("asks for a real SHA-256 repository", async () => {
    const top = join(root, "r");
    mkdirSync(top);
    execFileSync("git", ["init", "-q", "--object-format=sha256"], {
      cwd: top,
      stdio: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    expect(await check(top)).toBe(GIT_UNREADABLE);
  });
});

describe("paths are decoded as git reads the bytes (MC10, N3)", () => {
  it("asks for a gitfile path that is not valid UTF-8, even when its U+FFFD spelling names a repository", async () => {
    gitDir(join(root, "store\uFFFD"), DIRTY);
    mkdirSync(join(root, "w"));
    writeFileSync(
      join(root, "w", ".git"),
      Buffer.concat([Buffer.from(`gitdir: ${join(root, "store")}`), Buffer.from([0xff]), Buffer.from("\n")]),
    );
    expect(await check(join(root, "w"))).toBe(GIT_UNREADABLE);
  });
  it("asks for a commondir that is not valid UTF-8", async () => {
    repo(join(root, "main\uFFFD"));
    const wt = gitDir(join(root, "wt"));
    writeFileSync(
      join(wt, "commondir"),
      Buffer.concat([
        Buffer.from(join(root, "main")),
        Buffer.from([0xff, 0x2f, 0x2e, 0x67, 0x69, 0x74, 0x0a]),
      ]),
    );
    mkdirSync(join(root, "work"));
    writeFileSync(join(root, "work", ".git"), `gitdir: ${wt}\n`);
    expect(await check(join(root, "work"))).toBe(GIT_UNREADABLE);
  });
  it("asks for an include path that is not valid UTF-8, even when its U+FFFD spelling is a file", async () => {
    const top = repo(join(root, "r"));
    writeFileSync(join(top, "inc\uFFFD.cfg"), "[user]\n\tname = x\n");
    writeFileSync(
      join(top, ".git", "config"),
      Buffer.concat([
        Buffer.from(`${CLEAN}[include]\n\tpath = ../inc`),
        Buffer.from([0xff]),
        Buffer.from(".cfg\n"),
      ]),
    );
    expect(await check(top)).toBe(GIT_UNREADABLE);
  });
  it("still reads a config with a UTF-8 byte order mark and multi-byte text", async () => {
    const top = repo(join(root, "r"), `\uFEFF${CLEAN}[user]\n\tname = zo\u00e9\n[core]\n\tpager = x\n`);
    expect(await check(top)).toBe(GIT_RUNS_PROGRAM);
  });
});

describe("the git directory listing is bounded (N6)", () => {
  const fill = (top: string, extra: number): void => {
    const entries = 4; // HEAD, objects, refs, config
    for (let i = 0; i < MAX_GIT_DIR_ENTRIES - entries + extra; i++)
      writeFileSync(join(top, ".git", `f${i}`), "");
  };
  it("reads a git directory at the cap and asks for one entry more", async () => {
    const at = repo(join(root, "at"));
    fill(at, 0);
    expect(await check(at)).toBeNull();
    const over = repo(join(root, "over"));
    fill(over, 1);
    expect(await check(over)).toBe(GIT_UNREADABLE);
  });
});
