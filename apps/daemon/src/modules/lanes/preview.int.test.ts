import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeProjectBoxSource } from "../../kernel/testing/fake-boxes.ts";
import { testCaller } from "../../testing/caller.ts";
import { createLaneConfig } from "./preview.ts";
import { scriptHash } from "./project-config.ts";
import { lanesConfigRpc } from "./rpc-config.ts";
import { createLanesBed, type LanesBed } from "./testing/bed.ts";

let bed: LanesBed;
beforeEach(() => {
  bed = createLanesBed();
});
afterEach(() => bed.dispose());

const caller = () => testCaller({ stepUpUntil: bed.clock.now() + 60_000 });
const dated = (cwd: string, date: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    env: { ...bed.gb.setupEnv(), GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
    encoding: "utf8",
  });
const writeConfig = (text: string): string => {
  const path = join(bed.gb.root, ".pi", "project.yaml");
  mkdirSync(join(bed.gb.root, ".pi"), { recursive: true });
  writeFileSync(path, text);
  return path;
};

describe("lanes.preview of a box root", () => {
  it("preview of a box root never runs git", async () => {
    const root = "/boxes/11111111-1111-4111-8111-111111111111/project";
    const never = new Proxy(
      {},
      {
        get: () => {
          throw new Error("host git was called");
        },
      },
    ) as typeof bed.git;
    const boxes = createFakeProjectBoxSource({
      p: {
        ownerId: "u1",
        root,
        resources: { memoryMb: 2048, cpus: 2, diskMb: 8192 },
        hosts: [],
        deleting: false,
      },
    });
    const config = createLaneConfig({ ...bed.deps, git: never, roots: () => [root], boxes: () => boxes });
    const view = await config.preview(caller(), root);
    expect(view).toMatchObject({ repo: false, current: null, refs: [], remote: null, forge: null });
    expect(await config.forgeLine("u1", root)).toBeUndefined();
    expect(await config.approvedScript("u1", root, "setup")).toEqual({ ok: false, reason: "unapproved" });
  });
});

describe("lanes.preview", () => {
  it("answers the branch, the refs newest first and no remote HEAD", async () => {
    const { root } = bed.gb;
    const older = dated(root, "2020-01-01T00:00:00Z", "commit-tree", "-m", "old", "HEAD^{tree}").trim();
    bed.gb.git(root, "branch", "old", older);
    bed.gb.git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    bed.gb.git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    bed.gb.git(root, "tag", "v1");
    const view = await createLaneConfig(bed.deps).preview(caller(), root);
    expect(view.repo).toBe(true);
    expect(view.current).toBe("main");
    const names = view.refs.map((ref) => ref.ref);
    expect(names).toContain("refs/heads/main");
    expect(names).toContain("refs/remotes/origin/main");
    expect(names).not.toContain("refs/remotes/origin/HEAD");
    expect(names.some((name) => name.startsWith("refs/tags/"))).toBe(false);
    expect(names.indexOf("refs/heads/old")).toBe(names.length - 1);
    expect(view.refs.find((ref) => ref.ref === "refs/remotes/origin/main")).toMatchObject({
      label: "origin/main",
      oid: bed.gb.git(root, "rev-parse", "HEAD").trim(),
    });
    expect(view.refs.find((ref) => ref.ref === "refs/heads/old")?.at).toBe(
      Date.parse("2020-01-01T00:00:00Z"),
    );
    expect(view.remote).toBeNull();
    expect(view.forge).toBeNull();
  });

  it("marks a ref inLineage when it is HEAD or an ancestor of it, by lineage and not by name (Task 21)", async () => {
    const { root } = bed.gb;
    const own = bed.gb.git(root, "rev-parse", "HEAD").trim();
    const stranger = dated(root, "2020-01-01T00:00:00Z", "commit-tree", "-m", "theirs", "HEAD^{tree}").trim();
    bed.gb.git(root, "update-ref", "refs/remotes/origin/main", own);
    bed.gb.git(root, "update-ref", "refs/remotes/origin/theirs", stranger);
    bed.gb.git(root, "branch", "same-commit", own);
    // A local branch named like the owner's own work, whose commit is not in HEAD's line.
    bed.gb.git(root, "branch", "pi/mine", stranger);
    // HEAD moves on: the older commit is an ancestor of it now.
    bed.gb.git(root, "commit", "--allow-empty", "-q", "-m", "later");
    const refs = (await createLaneConfig(bed.deps).preview(caller(), root)).refs;
    const lineage = Object.fromEntries(refs.map((ref) => [ref.ref, ref.inLineage]));
    expect(lineage).toMatchObject({
      "refs/heads/main": true,
      "refs/heads/same-commit": true,
      "refs/remotes/origin/main": true, // an ancestor of the new HEAD
      "refs/remotes/origin/theirs": false,
      "refs/heads/pi/mine": false,
    });
  });

  it("answers the forge identity and the forge from the origin URL as configured (Task 14)", async () => {
    const { root } = bed.gb;
    bed.gb.git(root, "remote", "add", "origin", "https://github.com/o/r.git");
    const view = await createLaneConfig(bed.deps).preview(caller(), root);
    expect(view.remote).toEqual({ host: "github.com", path: "o/r" });
    expect(view.forge).toBe("github");
  });

  it("lets a known host win over the project's forge line, and uses the line for a host it does not know", async () => {
    const { root } = bed.gb;
    bed.gb.git(root, "remote", "add", "origin", "https://github.com/o/r.git");
    writeConfig("forge: gitlab\n");
    expect((await createLaneConfig(bed.deps).preview(caller(), root)).forge).toBe("github");
    bed.gb.git(root, "remote", "set-url", "origin", "https://git.example.com/o/r.git");
    const view = await createLaneConfig(bed.deps).preview(caller(), root);
    expect(view).toMatchObject({ remote: { host: "git.example.com", path: "o/r" }, forge: "gitlab" });
  });

  it("keeps the forge identity when a repository key makes the push target refuse", async () => {
    const { root } = bed.gb;
    bed.gb.git(root, "remote", "add", "origin", "https://github.com/o/r.git");
    bed.gb.git(root, "config", "core.sshCommand", "ssh -v");
    expect((await createLaneConfig(bed.deps).preview(caller(), root)).remote).toEqual({
      host: "github.com",
      path: "o/r",
    });
  });

  it("answers current null on a detached HEAD", async () => {
    bed.gb.git(bed.gb.root, "checkout", "-q", "--detach");
    expect((await createLaneConfig(bed.deps).preview(caller(), bed.gb.root)).current).toBeNull();
  });

  it("answers repo false for a subfolder of the project and for a linked worktree of another repository", async () => {
    const { root } = bed.gb;
    const sub = join(root, "pkg");
    mkdirSync(sub);
    const linked = join(mkdtempSync(join(bed.gb.dir, "wt-")), "lane");
    bed.gb.git(root, "worktree", "add", "-q", "-b", "other", linked);
    bed.projects.set("u1", [root, sub, linked]);
    const service = createLaneConfig(bed.deps);
    for (const path of [sub, linked]) {
      expect(await service.preview(caller(), path), path).toMatchObject({
        repo: false,
        refs: [],
        current: null,
      });
    }
  });

  it("answers repo false for a plain folder", async () => {
    const plain = join(bed.gb.dir, "plain");
    mkdirSync(plain);
    bed.projects.set("u1", [plain]);
    expect(await createLaneConfig(bed.deps).preview(caller(), plain)).toMatchObject({ repo: false });
  });

  it("answers not_found for another owner's root and for a folder that is not a root", async () => {
    const service = createLaneConfig(bed.deps);
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => "resolved",
        (error: unknown) => (error instanceof PapError ? error.code : String(error)),
      );
    expect(await code(service.preview(testCaller({ userId: "u2" }), bed.gb.root))).toBe("not_found");
    expect(await code(service.preview(caller(), join(bed.gb.root, ".pi")))).toBe("not_found");
    expect(await code(service.preview(caller(), "/"))).toBe("not_found");
  });

  it("is a lanes:read call: a token gets the same answer", async () => {
    const token = testCaller({ kind: "token" });
    expect((await createLaneConfig(bed.deps).preview(token, bed.gb.root)).repo).toBe(true);
  });

  it("marks approved scripts and shows the previous text in the config view", async () => {
    writeConfig("setup: echo one\ntest: pnpm test\ncopy: [.env]\nbranchPrefix: feat/\nwaitForSetup: false\n");
    const service = createLaneConfig(bed.deps);
    await service.approveScripts(caller(), {
      projectRoot: bed.gb.root,
      scripts: [{ kind: "setup", sha256: scriptHash("echo one") }],
    });
    writeConfig(
      "setup: echo two!\ntest: pnpm test\ncopy: [.env]\nbranchPrefix: feat/\nwaitForSetup: false\n",
    );
    const { config } = await service.preview(caller(), bed.gb.root);
    expect(config).toMatchObject({
      found: true,
      error: null,
      warnings: [],
      branchPrefix: "feat/",
      waitForSetup: false,
      copy: [".env"],
      link: [],
    });
    expect(config.scripts).toEqual([
      {
        kind: "setup",
        text: "echo two!",
        sha256: scriptHash("echo two!"),
        approved: false,
        previous: "echo one",
      },
      { kind: "test", text: "pnpm test", sha256: scriptHash("pnpm test"), approved: false, previous: null },
    ]);
  });

  it("defaults the prefix to pi/ and waitForSetup to true, and says when there is no file", async () => {
    const { config } = await createLaneConfig(bed.deps).preview(caller(), bed.gb.root);
    expect(config).toEqual({
      found: false,
      error: null,
      warnings: [],
      branchPrefix: "pi/",
      waitForSetup: true,
      copy: [],
      link: [],
      scripts: [],
    });
  });

  it("names the error of a file it cannot use, and the warnings of one bad field", async () => {
    const service = createLaneConfig(bed.deps);
    const errorOf = async () => (await service.preview(caller(), bed.gb.root)).config;
    writeConfig("setup: [\n");
    expect(await errorOf()).toMatchObject({ found: true, error: "invalid_yaml", scripts: [] });
    writeConfig("- a\n");
    expect(await errorOf()).toMatchObject({ error: "not_a_map" });
    writeConfig(`# ${"x".repeat(70_000)}\n`);
    expect(await errorOf()).toMatchObject({ error: "too_large" });
    writeConfig("setup: 12\nlink: [node_modules]\n");
    expect(await errorOf()).toMatchObject({ error: null, warnings: ["setup"], link: ["node_modules"] });
  });

  it("calls a FIFO and a link out of the repository unreadable", async () => {
    const service = createLaneConfig(bed.deps);
    const path = writeConfig("setup: x\n");
    execFileSync("rm", [path]);
    execFileSync("mkfifo", [path]);
    expect((await service.preview(caller(), bed.gb.root)).config).toMatchObject({
      found: true,
      error: "unreadable",
    });
    execFileSync("rm", [path]);
    writeFileSync(join(bed.gb.dir, "outside.yaml"), "setup: stolen\n");
    symlinkSync(join(bed.gb.dir, "outside.yaml"), path);
    expect((await service.preview(caller(), bed.gb.root)).config).toMatchObject({
      found: true,
      error: "unreadable",
      scripts: [],
    });
  });

  it("reads a link that stays inside the repository", async () => {
    mkdirSync(join(bed.gb.root, ".pi"), { recursive: true });
    writeFileSync(join(bed.gb.root, "real.yaml"), "test: pnpm test\n");
    symlinkSync(join(bed.gb.root, "real.yaml"), join(bed.gb.root, ".pi", "project.yaml"));
    const { config } = await createLaneConfig(bed.deps).preview(caller(), bed.gb.root);
    expect(config.scripts.map((script) => script.kind)).toEqual(["test"]);
  });

  it("does not parse an unchanged file again, and parses a changed one", async () => {
    const path = writeConfig("setup: aaa\n");
    const stamp = new Date("2021-01-01T00:00:00Z");
    utimesSync(path, stamp, stamp);
    const service = createLaneConfig(bed.deps);
    const first = await service.preview(caller(), bed.gb.root);
    // Same size and same mtime: the key is unchanged, so the cached read answers (a pure cache, M9R22).
    writeFileSync(path, "setup: bbb\n");
    utimesSync(path, stamp, stamp);
    expect((await service.preview(caller(), bed.gb.root)).config.scripts[0]?.text).toBe("aaa");
    utimesSync(path, new Date("2022-01-01T00:00:00Z"), new Date("2022-01-01T00:00:00Z"));
    expect((await service.preview(caller(), bed.gb.root)).config.scripts[0]?.text).toBe("bbb");
    expect(first.config.scripts[0]?.text).toBe("aaa");
  });
});

describe("lanes rpc", () => {
  it("hands the caller to the service and returns its answer", async () => {
    const rpc = lanesConfigRpc(createLaneConfig(bed.deps));
    const ctx = { caller: caller() } as never;
    const view = await rpc["lanes.preview"]({ projectRoot: bed.gb.root }, ctx);
    expect(view.repo).toBe(true);
    await expect(
      rpc["lanes.approveScripts"](
        { projectRoot: bed.gb.root, scripts: [{ kind: "setup", sha256: "0".repeat(64) }] },
        ctx,
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "changed",
    });
  });
});
