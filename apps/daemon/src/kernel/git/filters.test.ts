import { describe, expect, it } from "vitest";
import {
  disablingEnv,
  driversToDisable,
  guardFilters,
  MAX_FILTER_DRIVERS,
  parseGitVersion,
} from "./filters.ts";
import { FILTER_SCAN_ARGS } from "./exec.ts";
import { GitError, type GitRunner } from "./runner.ts";

/** What `git config --null --show-scope --get-regexp ^filter\.` prints. */
const scan = (
  ...entries: ReadonlyArray<readonly [scope: string, key: string, value: string | null]>
): Buffer =>
  Buffer.from(
    entries.map(([scope, key, value]) => `${scope}\0${key}${value === null ? "" : `\n${value}`}\0`).join(""),
  );
const LFS = [
  ["local", "filter.lfs.clean", "git-lfs clean -- %f"],
  ["local", "filter.lfs.smudge", "git-lfs smudge -- %f"],
  ["local", "filter.lfs.process", "git-lfs filter-process"],
  ["local", "filter.lfs.required", "true"],
] as const;

describe("driversToDisable (MC13)", () => {
  it("names a driver of the repository by its clean, smudge or process program", () => {
    for (const kind of ["clean", "smudge", "process"])
      expect(driversToDisable(scan(["local", `filter.evil.${kind}`, "/x/run.sh"]))).toEqual(["evil"]);
  });

  it("keeps a name with dots or an equals sign whole, and names it once", () => {
    expect(
      driversToDisable(
        scan(
          ["local", "filter.a=b.c.clean", "x"],
          ["worktree", "filter.a=b.c.smudge", "x"],
          ["local", "filter.v1.2.process", "x"],
        ),
      ),
    ).toEqual(["a=b.c", "v1.2"]);
  });

  it("finds a driver whichever local scope it came from, an include included", () => {
    expect(
      driversToDisable(scan(["worktree", "filter.w.clean", "x"], ["local", "filter.l.clean", "x"])),
    ).toEqual(["w", "l"]);
  });

  it("leaves the owner's system and global config alone", () => {
    expect(
      driversToDisable(scan(["system", "filter.s.clean", "x"], ["global", "filter.g.clean", "x"])),
    ).toEqual([]);
  });

  it("treats a scope it does not know as the repository's (fail closed)", () => {
    expect(driversToDisable(scan(["somethingnew", "filter.n.clean", "x"]))).toEqual(["n"]);
  });

  it("leaves the exact git-lfs entries, and empties the driver when any one differs", () => {
    expect(driversToDisable(scan(...LFS))).toEqual([]);
    expect(driversToDisable(scan(...LFS, ["local", "filter.lfs.smudge", "evil.sh"]))).toEqual(["lfs"]);
    expect(driversToDisable(scan(["local", "filter.lfs.clean", "git-lfs clean -- %f; evil"]))).toEqual([
      "lfs",
    ]);
    expect(driversToDisable(scan(["local", "filter.other.clean", "git-lfs clean -- %f"]))).toEqual(["other"]);
    expect(driversToDisable(scan(["local", "filter.lfs.clean", null]))).toEqual(["lfs"]);
  });

  it("ignores entries that run nothing, and an empty scan", () => {
    expect(
      driversToDisable(scan(["local", "filter.x.required", "true"], ["local", "filter.x.usexattrs", "1"])),
    ).toEqual([]);
    expect(driversToDisable(Buffer.alloc(0))).toEqual([]);
  });

  it("gives up on more drivers than the environment can carry", () => {
    const many = Array.from({ length: MAX_FILTER_DRIVERS + 1 }, (_, n): ["local", string, string] => [
      "local",
      `filter.d${n}.clean`,
      "x",
    ]);
    expect(driversToDisable(scan(...many))).toBeNull();
    expect(driversToDisable(scan(...many.slice(0, MAX_FILTER_DRIVERS)))).toHaveLength(MAX_FILTER_DRIVERS);
  });
});

describe("an empty driver name (I2)", () => {
  it("is named and emptied like any other", () => {
    expect(driversToDisable(scan(["local", "filter..clean", "x"]))).toEqual([""]);
    expect(disablingEnv([""])).toMatchObject({ GIT_CONFIG_KEY_0: "filter..clean", GIT_CONFIG_VALUE_0: "" });
  });
});

describe("disablingEnv", () => {
  it("empties the three programs and drops `required`, one config entry each", () => {
    expect(disablingEnv(["a=b"])).toEqual({
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_0: "filter.a=b.clean",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "filter.a=b.smudge",
      GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "filter.a=b.process",
      GIT_CONFIG_VALUE_2: "",
      GIT_CONFIG_KEY_3: "filter.a=b.required",
      GIT_CONFIG_VALUE_3: "false",
    });
    expect(disablingEnv([])).toEqual({ GIT_CONFIG_COUNT: "0" });
  });
});

describe("guardFilters", () => {
  function recorder(scanOut: Buffer) {
    const calls: Array<{ args: readonly string[]; env?: Record<string, string> | undefined }> = [];
    const raw: GitRunner = {
      run: async (_root, args, options) => {
        calls.push({ args, env: options?.env });
        return { stdout: args[0] === "config" ? scanOut : Buffer.from("out"), code: 0 };
      },
    };
    return { guarded: guardFilters(raw, { gitVersion: async () => "git version 2.53.0" }), calls };
  }

  it.each([["status"], ["diff"]])(
    "asks for the drivers before %s, then runs it with them emptied",
    async (sub) => {
      const { guarded, calls } = recorder(scan(["local", "filter.evil.clean", "x"]));
      await guarded.run("/r", [sub, "HEAD"]);
      expect(calls.map((call) => call.args)).toEqual([[...FILTER_SCAN_ARGS], [sub, "HEAD"]]);
      expect(calls[1]?.env).toMatchObject({ GIT_CONFIG_KEY_0: "filter.evil.clean", GIT_CONFIG_VALUE_0: "" });
    },
  );

  it("does not ask before a subcommand that compares no working-tree file", async () => {
    const { guarded, calls } = recorder(scan());
    for (const sub of ["rev-parse", "ls-files", "cat-file", "check-ignore", "show", "log"])
      await guarded.run("/r", [sub]);
    expect(calls.map((call) => call.args[0])).toEqual([
      "rev-parse",
      "ls-files",
      "cat-file",
      "check-ignore",
      "show",
      "log",
    ]);
  });

  it("refuses the call when the repository names too many drivers", async () => {
    const many = Array.from({ length: MAX_FILTER_DRIVERS + 1 }, (_, n): ["local", string, string] => [
      "local",
      `filter.d${n}.clean`,
      "x",
    ]);
    const { guarded, calls } = recorder(scan(...many));
    await expect(guarded.run("/r", ["status"])).rejects.toBeInstanceOf(GitError);
    expect(calls).toHaveLength(1);
  });
});

describe("the git version floor (M1)", () => {
  const evil = scan(["local", "filter.evil.clean", "x"]);
  function old(version: string, out: Buffer) {
    const calls: string[] = [];
    let asked = 0;
    const raw: GitRunner = {
      run: async (_root, args) => {
        calls.push(args[0] ?? "");
        return { stdout: args[0] === "config" ? out : Buffer.from("out"), code: 0 };
      },
    };
    const guarded = guardFilters(raw, {
      gitVersion: async () => {
        asked += 1;
        return `git version ${version}`;
      },
    });
    return { guarded, calls, asked: () => asked };
  }

  it("parses the version, and reads an unreadable one as the oldest", () => {
    expect(parseGitVersion("git version 2.30.2\n")).toEqual([2, 30]);
    expect(parseGitVersion("git version 2.53.0.windows.1")).toEqual([2, 53]);
    expect(parseGitVersion("nonsense")).toEqual([0, 0]);
  });

  it("refuses status and diff on git 2.30 when the repository defines a driver, and runs them when it defines none", async () => {
    const withDriver = old("2.30.2", evil);
    for (const sub of ["status", "diff"])
      await expect(withDriver.guarded.run("/r", [sub])).rejects.toMatchObject({ kind: "git_too_old" });
    expect(withDriver.calls).toEqual(["config", "config"]);
    const clean = old("2.30.2", scan());
    await expect(clean.guarded.run("/r", ["status"])).resolves.toMatchObject({ code: 0 });
  });

  it("refuses everything that compares files below 2.26, where the scan does not exist", async () => {
    const ancient = old("2.25.1", scan());
    await expect(ancient.guarded.run("/r", ["status"])).rejects.toMatchObject({ kind: "git_too_old" });
    expect(ancient.calls).toEqual([]);
    await expect(ancient.guarded.run("/r", ["rev-parse"])).resolves.toMatchObject({ code: 0 });
  });

  it("runs with the overrides from 2.31 on, and asks for the version once", async () => {
    const fine = old("2.31.0", evil);
    await fine.guarded.run("/r", ["status"]);
    await fine.guarded.run("/r", ["diff"]);
    expect(fine.asked()).toBe(1);
  });
});
