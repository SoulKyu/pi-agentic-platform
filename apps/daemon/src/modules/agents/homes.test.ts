import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
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
import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitRunner } from "../../kernel/git/runner.ts";
import { silentLogger } from "../../kernel/logger.ts";
import {
  agentsRoot,
  HomeMovedRunsLeft,
  initHome,
  makeHome,
  memoryHeader,
  trashedEntryOf,
  trashHome,
  trashHomeOrFind,
} from "./homes.ts";

let dir: string;
let papHome: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-homes-"));
  papHome = join(dir, "pap");
  mkdirSync(papHome, { mode: 0o700 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const modeOf = (path: string): number => statSync(path).mode & 0o777;
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof PapError ? error.code : String(error);
  }
  return undefined;
};

describe("makeHome", () => {
  it("makes agents/ and the home 0700, and nothing else", () => {
    const home = makeHome(papHome, "atlas-1a2b");
    expect(home).toBe(join(agentsRoot(papHome), "atlas-1a2b"));
    expect(modeOf(home)).toBe(0o700);
    expect(modeOf(join(papHome, "agents"))).toBe(0o700);
    expect(readdirSync(home)).toEqual([]);
  });

  it("refuses an existing id (conflict), never reusing the folder", () => {
    const home = makeHome(papHome, "atlas-1a2b");
    writeFileSync(join(home, "keep"), "x");
    expect(code(() => makeHome(papHome, "atlas-1a2b"))).toBe("conflict");
    expect(readFileSync(join(home, "keep"), "utf8")).toBe("x");
  });

  it("refuses a name that is not an agent id", () => {
    for (const id of ["../x-1a2b", ".runs", ".trash", "atlas", "a/b-1a2b"])
      expect(
        code(() => makeHome(papHome, id)),
        id,
      ).toBe("bad_request");
    expect(existsSync(join(papHome, "x-1a2b"))).toBe(false);
  });

  it("refuses an agents folder that is a link or a file", () => {
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(papHome, "agents"));
    expect(code(() => makeHome(papHome, "atlas-1a2b"))).toBe("internal");
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(join(papHome, "agents"));
    writeFileSync(join(papHome, "agents"), "x");
    expect(code(() => makeHome(papHome, "atlas-1a2b"))).toBe("internal");
  });
});

describe("trashHome", () => {
  it("moves a home holding a link to the owner's folder without touching what it points at", () => {
    const owners = join(dir, "owners-home");
    mkdirSync(owners);
    writeFileSync(join(owners, "precious"), "keep");
    const inode = statSync(owners).ino;
    const home = makeHome(papHome, "atlas-1a2b");
    symlinkSync(owners, join(home, "link"));
    const target = trashHome(papHome, "atlas-1a2b", 1700);
    expect(target).toBe(join(papHome, "agents", ".trash", "atlas-1a2b-1700"));
    expect(existsSync(home)).toBe(false);
    expect(lstatSync(join(target, "link")).isSymbolicLink()).toBe(true);
    expect(statSync(owners).ino).toBe(inode);
    expect(readFileSync(join(owners, "precious"), "utf8")).toBe("keep");
    expect(modeOf(join(papHome, "agents", ".trash"))).toBe(0o700);
  });

  it("moves the scratch folders beside it when there are any", () => {
    makeHome(papHome, "atlas-1a2b");
    mkdirSync(join(papHome, "agents", ".runs", "atlas-1a2b", "task-1"), { recursive: true });
    writeFileSync(join(papHome, "agents", ".runs", "atlas-1a2b", "task-1", "out.txt"), "r");
    const target = trashHome(papHome, "atlas-1a2b", 5);
    expect(readFileSync(`${target}.runs/task-1/out.txt`, "utf8")).toBe("r");
    expect(existsSync(join(papHome, "agents", ".runs", "atlas-1a2b"))).toBe(false);
    expect(readdirSync(join(papHome, "agents", ".trash")).sort()).toEqual([
      "atlas-1a2b-5",
      "atlas-1a2b-5.runs",
    ]);
  });

  it("refuses a scratch folder that is a link, before the home moves", () => {
    makeHome(papHome, "atlas-1a2b");
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(join(papHome, "agents", ".runs"));
    symlinkSync(elsewhere, join(papHome, "agents", ".runs", "atlas-1a2b"));
    expect(code(() => trashHome(papHome, "atlas-1a2b", 1))).toBe("internal");
    expect(existsSync(join(papHome, "agents", "atlas-1a2b"))).toBe(true);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses a .runs folder that is a link, before the home moves", () => {
    makeHome(papHome, "atlas-1a2b");
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(join(elsewhere, "atlas-1a2b"), { recursive: true });
    symlinkSync(elsewhere, join(papHome, "agents", ".runs"));
    expect(code(() => trashHome(papHome, "atlas-1a2b", 1))).toBe("internal");
    expect(existsSync(join(papHome, "agents", "atlas-1a2b"))).toBe(true);
  });

  it("tells a scratch folder that stayed behind once the home has moved", () => {
    makeHome(papHome, "atlas-1a2b");
    mkdirSync(join(papHome, "agents", ".runs", "atlas-1a2b"), { recursive: true });
    mkdirSync(join(papHome, "agents", ".trash", "atlas-1a2b-7.runs", "busy"), { recursive: true });
    expect(() => trashHome(papHome, "atlas-1a2b", 7)).toThrow(HomeMovedRunsLeft);
    expect(existsSync(join(papHome, "agents", "atlas-1a2b"))).toBe(false);
    expect(existsSync(join(papHome, "agents", ".runs", "atlas-1a2b"))).toBe(true);
  });

  it("a retry after HomeMovedRunsLeft moves the scratch folders left behind, beside the trashed home", () => {
    makeHome(papHome, "atlas-1a2b");
    mkdirSync(join(papHome, "agents", ".runs", "atlas-1a2b", "task-1"), { recursive: true });
    mkdirSync(join(papHome, "agents", ".trash", "atlas-1a2b-7.runs", "busy"), { recursive: true });
    expect(() => trashHome(papHome, "atlas-1a2b", 7)).toThrow(HomeMovedRunsLeft);
    expect(trashHomeOrFind(papHome, "atlas-1a2b", 8)).toBe("atlas-1a2b-7");
    expect(existsSync(join(papHome, "agents", ".runs", "atlas-1a2b"))).toBe(false);
    expect(existsSync(join(papHome, "agents", ".trash", "atlas-1a2b-7.runs", "busy"))).toBe(true);
    expect(existsSync(join(papHome, "agents", ".trash", "atlas-1a2b-7.runs-8", "task-1"))).toBe(true);
    // Nothing left to move: a second retry changes nothing.
    expect(trashHomeOrFind(papHome, "atlas-1a2b", 9)).toBe("atlas-1a2b-7");
  });

  it("refuses a trash folder that is a link, and a bad id", () => {
    makeHome(papHome, "atlas-1a2b");
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(papHome, "agents", ".trash"));
    expect(code(() => trashHome(papHome, "atlas-1a2b", 1))).toBe("internal");
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(code(() => trashHome(papHome, "../x-1a2b", 1))).toBe("bad_request");
  });

  it("finds the newest entry of an agent already trashed", () => {
    makeHome(papHome, "atlas-1a2b");
    trashHome(papHome, "atlas-1a2b", 9);
    mkdirSync(join(papHome, "agents", ".trash", "atlas-1a2b-10"));
    mkdirSync(join(papHome, "agents", ".trash", "atlas-1a2b-3.runs"));
    mkdirSync(join(papHome, "agents", ".trash", "other-1a2b-99"));
    expect(trashedEntryOf(papHome, "atlas-1a2b")).toBe("atlas-1a2b-10");
    expect(trashedEntryOf(papHome, "none-0000")).toBe("");
  });
});

describe("initHome (M11R46)", () => {
  // A temporary HOME: the owner's real ~/.gitconfig (templates, hooks, signing) must not shape the result.
  let userHome: string;
  let git: ReturnType<typeof createGitRunner>;
  beforeEach(() => {
    userHome = join(dir, "user-home");
    mkdirSync(userHome);
    git = createGitRunner({ env: { PATH: process.env.PATH, HOME: userHome }, logger: silentLogger });
  });
  const run = (home: string, ...args: string[]): string =>
    execFileSync("git", ["-C", home, ...args], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: userHome,
        XDG_CONFIG_HOME: join(userHome, ".config"),
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }).trim();

  it("seeds MEMORY.md (0600), prompts/ (0700), .gitignore and one commit by the agent", async () => {
    const home = makeHome(papHome, "atlas-1a2b");
    await initHome(git, home, { id: "atlas-1a2b", name: "Atlas" });
    expect(modeOf(join(home, "MEMORY.md"))).toBe(0o600);
    expect(modeOf(join(home, "prompts"))).toBe(0o700);
    expect(readFileSync(join(home, "MEMORY.md"), "utf8")).toBe(memoryHeader("Atlas"));
    expect(readFileSync(join(home, ".gitignore"), "utf8")).toBe(".pi/\n.claude/\n");
    expect(run(home, "log", "--format=%an <%ae>|%cn <%ce>|%s")).toBe(
      "Atlas <atlas-1a2b@pap.local>|Atlas <atlas-1a2b@pap.local>|chore: init Atlas home",
    );
    expect(run(home, "rev-list", "--count", "HEAD")).toBe("1");
    expect(run(home, "branch", "--show-current")).toBe("main");
    expect(run(home, "ls-files").split("\n").sort()).toEqual([".gitignore", "MEMORY.md"]);
    expect(run(home, "config", "--local", "user.email")).toBe("atlas-1a2b@pap.local");
  });

  it("keeps .claude/ out of the home's git status", async () => {
    const home = makeHome(papHome, "atlas-1a2b");
    await initHome(git, home, { id: "atlas-1a2b", name: "Atlas" });
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", ".credentials.json"), "{}\n");
    expect(run(home, "status", "--porcelain")).toBe("");
  });

  it("copies no hook template and runs none", async () => {
    const template = join(dir, "template");
    mkdirSync(join(template, "hooks"), { recursive: true });
    writeFileSync(join(template, "hooks", "post-commit"), `#!/bin/sh\ntouch ${join(dir, "hook-ran")}\n`, {
      mode: 0o755,
    });
    const home = makeHome(papHome, "atlas-1a2b");
    // The owner's own git config names a template folder: the runner keeps HOME, so `init` would copy it.
    const ownerHome = join(dir, "user");
    mkdirSync(ownerHome);
    writeFileSync(join(ownerHome, ".gitconfig"), `[init]\n\ttemplateDir = ${template}\n`);
    const withTemplate = createGitRunner({
      env: { PATH: process.env.PATH, HOME: ownerHome },
      logger: silentLogger,
    });
    await initHome(withTemplate, home, { id: "atlas-1a2b", name: "Atlas" });
    expect(existsSync(join(home, ".git", "hooks", "post-commit"))).toBe(false);
    expect(existsSync(join(dir, "hook-ran"))).toBe(false);
  });

  it("starts with a six-line header that names the agent and says isolated tasks cannot write the file", () => {
    const header = memoryHeader("Atlas");
    expect(header.endsWith("\n")).toBe(true);
    expect(header.slice(0, -1).split("\n")).toHaveLength(6);
    expect(header).toContain("Atlas");
    expect(header).toMatch(/isolated tasks cannot write this file/i);
    expect(header).toMatch(/summary card/i);
  });
});
