import { describe, expect, it } from "vitest";
import { dropNewGitlinks } from "./nested.ts";
import type { GitRunner } from "./runner.ts";

const raw = (...entries: Array<[string, string, string, string]>) =>
  Buffer.from(
    entries.map(([o, n, s, p]) => `:${o} ${n} ${"0".repeat(40)} ${"1".repeat(40)} ${s}\0${p}\0`).join(""),
  );

function fake(diff: Buffer) {
  const calls: Array<{ args: string[]; input?: Buffer; env?: Record<string, string>; gitDir?: string }> = [];
  const git: GitRunner = {
    async run(_root, args, options = {}) {
      calls.push({
        args: [...args],
        input: options.input,
        env: options.env as never,
        gitDir: options.gitDir,
      });
      return { stdout: args[0] === "diff" ? diff : Buffer.alloc(0), code: 0 };
    },
  };
  return { git, calls };
}

describe("dropNewGitlinks", () => {
  it("removes the gitlinks that HEAD does not have from the index, with the index and git dir it was given", async () => {
    const { git, calls } = fake(
      raw(
        ["000000", "100644", "A", "a.txt"],
        ["000000", "160000", "A", "vendor/lib"],
        ["160000", "160000", "M", "sub"],
      ),
    );
    const dir = "/r/.git/worktrees/l";
    expect(await dropNewGitlinks(git, "/wt/l", dir, { GIT_INDEX_FILE: "/i/idx" })).toEqual(["vendor/lib"]);
    expect(calls.map((call) => call.args)).toEqual([
      ["diff", "--cached", "--raw", "-z", "--no-abbrev", "--ignore-submodules=dirty"],
      ["rm", "--cached", "-f", "--quiet", "--pathspec-from-file=-", "--pathspec-file-nul"],
    ]);
    expect(calls[1]?.input?.toString("utf8")).toBe("vendor/lib\0");
    for (const call of calls) {
      expect(call.gitDir).toBe(dir);
      expect(call.env).toEqual({ GIT_INDEX_FILE: "/i/idx" });
    }
  });

  it("counts a file turned into a gitlink, and runs nothing more when there is none", async () => {
    const turned = fake(raw(["100644", "160000", "T", "x"]));
    expect(await dropNewGitlinks(turned.git, "/wt", "/r/.git/worktrees/l")).toEqual(["x"]);
    const none = fake(raw(["000000", "100644", "A", "a.txt"]));
    expect(await dropNewGitlinks(none.git, "/wt", "/r/.git/worktrees/l")).toEqual([]);
    expect(none.calls).toHaveLength(1);
  });

  it("keeps the bytes of a path that is not UTF-8 when asked for latin1", async () => {
    const { git, calls } = fake(
      Buffer.from(`:000000 160000 ${"0".repeat(40)} ${"1".repeat(40)} A\0v\xe9/lib\0`, "latin1"),
    );
    expect(await dropNewGitlinks(git, "/wt", "/r/.git/worktrees/l", {}, "latin1")).toEqual(["v\xe9/lib"]);
    expect([...(calls[1]?.input ?? [])].slice(0, 3)).toEqual([0x76, 0xe9, 0x2f]);
  });
});
