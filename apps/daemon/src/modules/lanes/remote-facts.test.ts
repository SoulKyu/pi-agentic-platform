import { describe, expect, it, vi } from "vitest";
import { ORIGIN_URLS_ARGS, PUSH_SCAN_ARGS } from "../../kernel/git/exec.ts";
import type { GitRunner } from "../../kernel/git/runner.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createRemoteFacts, readRemoteInfo } from "./remote-facts.ts";

const buf = (text: string) => Buffer.from(text);
const same = (a: readonly string[], b: readonly string[]) => a.join("\0") === b.join("\0");

function fakeGit(script: { origin?: string; push?: string; scan?: string }) {
  const calls: string[][] = [];
  const git: GitRunner = {
    async run(_root, args) {
      calls.push([...args]);
      if (same(args, PUSH_SCAN_ARGS)) return { stdout: buf(script.scan ?? ""), code: 0 };
      if (same(args, ORIGIN_URLS_ARGS)) return { stdout: buf(script.origin ?? ""), code: 0 };
      if (args[0] === "remote") return { stdout: buf(script.push ?? script.origin ?? ""), code: 0 };
      throw new Error(`unexpected ${args.join(" ")}`);
    },
  };
  return { git, calls };
}
const GH = "https://github.com/o/r.git\n";
const deps = (git: GitRunner) => ({ git, logger: silentLogger, allowFile: false });
const LANE = { root: "/wt/l1", gitDir: "/r/.git/worktrees/l1" };

describe("readRemoteInfo", () => {
  it("reads the identity, the forge and where a push would go", async () => {
    const { git } = fakeGit({ origin: GH, push: "git@github.com:o/r.git\n" });
    expect(await readRemoteInfo(deps(git), LANE, undefined)).toEqual({
      remote: { host: "github.com", path: "o/r" },
      pushRemote: { host: "github.com", path: "o/r" },
      forge: "github",
    });
  });

  it("keeps the identity and drops the push target when the target is refused", async () => {
    const { git } = fakeGit({ origin: GH, push: "https://github.com/o/other.git\n" });
    expect(await readRemoteInfo(deps(git), LANE, undefined)).toEqual({
      remote: { host: "github.com", path: "o/r" },
      pushRemote: null,
      forge: "github",
    });
  });

  it("lets a known host win over the project's forge line", async () => {
    const { git } = fakeGit({ origin: GH });
    expect((await readRemoteInfo(deps(git), LANE, "gitlab")).forge).toBe("github");
  });

  it("uses the project's forge line for a host pap does not know", async () => {
    const { git } = fakeGit({ origin: "https://git.example.com/o/r.git\n" });
    expect((await readRemoteInfo(deps(git), LANE, "gitea")).forge).toBe("gitea");
    expect((await readRemoteInfo(deps(git), LANE, undefined)).forge).toBeNull();
  });

  it("answers nothing for a repository without origin", async () => {
    const { git } = fakeGit({});
    expect(await readRemoteInfo(deps(git), LANE, undefined)).toEqual({
      remote: null,
      pushRemote: null,
      forge: null,
    });
  });

  it("keeps the identity when a local key makes the push refuse", async () => {
    const { git } = fakeGit({ origin: GH, scan: "local\0core.sshcommand\nssh -x\0" });
    expect(await readRemoteInfo(deps(git), LANE, undefined)).toMatchObject({
      remote: { host: "github.com", path: "o/r" },
      pushRemote: null,
    });
  });
});

describe("createRemoteFacts", () => {
  const row = { id: "l1", ownerId: "u1", projectRoot: "/p", worktree: "/wt/l1", state: "active" } as const;
  const make = (git: GitRunner, over: { state?: string; override?: "gitlab" } = {}) => {
    const changed = vi.fn();
    const forgeOverride = vi.fn(async () => over.override);
    const facts = createRemoteFacts({
      git,
      logger: silentLogger,
      allowFile: false,
      store: { get: () => ({ ...row, state: over.state ?? "active" }) as never },
      gitDirOf: () => LANE.gitDir,
      forgeOverride,
      changed,
    });
    return { facts, changed, forgeOverride };
  };

  it("is empty until read, loads once in the background on the first view, and publishes", async () => {
    const { git, calls } = fakeGit({ origin: GH });
    const { facts, changed } = make(git);
    expect(facts.view("l1")).toEqual({ remote: null, pushRemote: null, forge: null });
    expect(facts.view("l1")).toEqual({ remote: null, pushRemote: null, forge: null });
    await facts.settled();
    expect(changed).toHaveBeenCalledWith("l1");
    expect(facts.get("l1")).toMatchObject({ remote: { host: "github.com", path: "o/r" }, forge: "github" });
    const reads = calls.length;
    facts.view("l1");
    await facts.settled();
    expect(calls.length).toBe(reads);
  });

  it("refresh reads again, from the lane root with the stored git dir", async () => {
    const { git } = fakeGit({ origin: GH });
    const seen: Array<[string, string | undefined]> = [];
    const spy: GitRunner = {
      run: (root, args, options) => {
        seen.push([root, options?.gitDir]);
        return git.run(root, args, options);
      },
    };
    const { facts } = make(spy);
    await facts.refresh("l1");
    expect(seen.length).toBeGreaterThan(0);
    for (const entry of seen) expect(entry).toEqual(["/wt/l1", LANE.gitDir]);
  });

  it("does not read a lane that is not active, and forgets on request", async () => {
    const { git, calls } = fakeGit({ origin: GH });
    const { facts } = make(git, { state: "archived" });
    facts.view("l1");
    await facts.settled();
    expect(calls).toEqual([]);
    const active = make(git);
    await active.facts.refresh("l1");
    active.facts.forget("l1");
    expect(active.facts.get("l1")).toEqual({ remote: null, pushRemote: null, forge: null });
  });

  it("applies the project's forge line through the override", async () => {
    const { git } = fakeGit({ origin: "https://git.example.com/o/r.git\n" });
    const { facts } = make(git, { override: "gitlab" });
    await facts.refresh("l1");
    expect(facts.get("l1").forge).toBe("gitlab");
  });
});
