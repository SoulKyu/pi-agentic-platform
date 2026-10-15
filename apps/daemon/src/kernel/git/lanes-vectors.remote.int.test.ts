import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../logger.ts";
import { createGitBed, type GitBed } from "../testing/git-bed.ts";
import { ORIGIN_URLS_ARGS, PUSH_SCAN_ARGS } from "./exec.ts";
import { pushTarget } from "./push-target.ts";
import { repositoryKeys } from "./repo-scan.ts";
import { createGitRunner } from "./runner.ts";

// The remote half of the lane vectors, with real git and a local bare repository as the remote (no network).
let bed: GitBed;
let bare: string;
beforeEach(() => {
  bed = createGitBed();
  bare = join(bed.dir, "remote.git");
  bed.git(bed.dir, "init", "-q", "--bare", "-b", "main", bare);
  bed.git(bed.root, "remote", "add", "origin", bare);
  bed.git(bed.root, "branch", "pi/x");
});
afterEach(() => bed.dispose());

const PUSH = ["push", "--porcelain", "--set-upstream", "origin", "refs/heads/pi/x:refs/heads/pi/x"];
const runnerWith = (remoteProtocols?: string) =>
  createGitRunner({
    env: { PATH: process.env.PATH, HOME: bed.home },
    logger: silentLogger,
    ...(remoteProtocols === undefined ? {} : { remoteProtocols }),
  });
const lines = (out: { stdout: Buffer }): string[] =>
  out.stdout
    .toString("utf8")
    .split("\n")
    .filter((line) => line !== "");
const originUrls = async (): Promise<string[]> =>
  lines(await bed.runner().run(bed.root, [...ORIGIN_URLS_ARGS], { okCodes: [0, 1] }));
const pushUrls = async (): Promise<string[]> =>
  lines(await bed.runner().run(bed.root, ["remote", "get-url", "--push", "--all", "origin"]));
const remoteBranches = (): string => bed.git(bare, "branch", "--list", "pi/x");

describe("the push protocols (M9R10)", () => {
  it("production protocols refuse a file remote", async () => {
    const out = await runnerWith().run(bed.root, PUSH, {
      profile: "remote",
      okCodes: [0, 1, 128],
      keepStderr: true,
    });
    expect(out.code).toBe(128);
    expect(out.stderr).toContain("not allowed");
    expect(remoteBranches().trim()).toBe("");
  });

  it("the test protocols push it, with the exact branch only", async () => {
    const out = await runnerWith("file").run(bed.root, PUSH, { profile: "remote", keepStderr: true });
    expect(out.code).toBe(0);
    expect(remoteBranches()).toContain("pi/x");
    expect(bed.git(bare, "tag", "--list").trim()).toBe("");
  });
});

describe("a repository's own push options (MC4 I1)", () => {
  /** A receive-pack that advertises push options and lets the bare repository's hook see them (the `-c` set would switch hooks off). */
  function recordingRemote(): string {
    const record = join(bed.dir, "options.txt");
    const hook = join(bare, "hooks", "pre-receive");
    writeFileSync(hook, `#!/bin/sh\necho "$GIT_PUSH_OPTION_COUNT" > '${record}'\n`);
    chmodSync(hook, 0o755);
    bed.git(bare, "config", "receive.advertisePushOptions", "true");
    const wrapper = bed.dir + "/receive-pack.sh";
    writeFileSync(
      wrapper,
      `#!/bin/sh\nunset GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT\nexec git receive-pack "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    bed.git(bed.root, "config", "remote.origin.receivepack", wrapper);
    for (const option of [
      "merge_request.create",
      "merge_request.target=main",
      "merge_request.merge_when_pipeline_succeeds",
      "ci.variable=DEPLOY=prod",
    ])
      bed.git(bed.root, "config", "--add", "push.pushOption", option);
    return record;
  }

  it("plain git sends the four repository options (control)", () => {
    const record = recordingRemote();
    bed.git(bed.root, "push", "origin", "pi/x");
    expect(readFileSync(record, "utf8").trim()).toBe("4");
  });

  it("the remote profile sends none", async () => {
    const record = recordingRemote();
    const out = await runnerWith("file").run(bed.root, PUSH, { profile: "remote", keepStderr: true });
    expect(out.code).toBe(0);
    expect(remoteBranches()).toContain("pi/x");
    expect(readFileSync(record, "utf8").trim()).toBe("0");
  });
});

describe("a repository's own config that would run a program (M9R14)", () => {
  it("a planted receivepack fires under plain git, and the scan lists it so no push is made", async () => {
    const plant = bed.plant("receivepack");
    bed.git(bed.root, "config", "remote.origin.receivepack", plant.script);
    // Control: plain git runs the program.
    try {
      bed.git(bed.root, "push", "origin", "pi/x");
    } catch {
      // The planted program is not a receive-pack: the push fails, the marker is what counts.
    }
    expect(existsSync(plant.marker)).toBe(true);
    rmSync(plant.marker);

    const scan = await bed.runner().run(bed.root, [...PUSH_SCAN_ARGS], { okCodes: [0, 1] });
    expect(repositoryKeys(scan.stdout)).toEqual(["remote.origin.receivepack"]);
    // The caller stops on a non-empty scan: nothing ran.
    expect(existsSync(plant.marker)).toBe(false);
  });
});

describe("where a push really goes (M9-RT-02)", () => {
  it("get-url --push --all prints both of two pushurl values; pushTarget refuses them", async () => {
    bed.git(bed.root, "config", "remote.origin.url", "https://github.com/o/r.git");
    bed.git(bed.root, "config", "--add", "remote.origin.pushurl", "https://github.com/o/r.git");
    bed.git(bed.root, "config", "--add", "remote.origin.pushurl", "https://evil.example/o/r.git");
    const push = await pushUrls();
    expect(push).toEqual(["https://github.com/o/r.git", "https://evil.example/o/r.git"]);
    expect(pushTarget({ originUrls: await originUrls(), pushUrls: push, allowFile: false })).toEqual({
      ok: false,
      reason: "repo_config",
    });
  });

  it("two url values are both listed; pushTarget refuses them", async () => {
    bed.git(bed.root, "config", "remote.origin.url", "https://github.com/o/r.git");
    bed.git(bed.root, "config", "--add", "remote.origin.url", "https://evil.example/o/r.git");
    const origin = await originUrls();
    expect(origin).toHaveLength(2);
    expect(pushTarget({ originUrls: origin, pushUrls: await pushUrls(), allowFile: false })).toEqual({
      ok: false,
      reason: "repo_config",
    });
  });

  it("a pushurl of another repository is refused, a same-repository ssh pushurl accepted", async () => {
    bed.git(bed.root, "config", "remote.origin.url", "https://github.com/o/r.git");
    bed.git(bed.root, "config", "remote.origin.pushurl", "https://github.com/o/other.git");
    const refused = pushTarget({
      originUrls: await originUrls(),
      pushUrls: await pushUrls(),
      allowFile: false,
    });
    expect(refused).toEqual({ ok: false, reason: "repo_config" });
    bed.git(bed.root, "config", "remote.origin.pushurl", "git@github.com:o/r.git");
    const accepted = pushTarget({
      originUrls: await originUrls(),
      pushUrls: await pushUrls(),
      allowFile: false,
    });
    expect(accepted).toEqual({ ok: true, target: { host: "github.com", path: "o/r" } });
  });

  it("an owner-global insteadOf is read after rewriting, the identity before it", async () => {
    writeFileSync(
      join(bed.home, ".gitconfig"),
      '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n',
    );
    bed.git(bed.root, "config", "remote.origin.url", "https://github.com/o/r.git");
    // The runner's env has HOME = bed.home, so it reads the same global file.
    expect(await originUrls()).toEqual(["https://github.com/o/r.git"]);
    expect(await pushUrls()).toEqual(["git@github.com:o/r.git"]);
    expect(
      pushTarget({ originUrls: await originUrls(), pushUrls: await pushUrls(), allowFile: false }),
    ).toMatchObject({
      ok: true,
    });
  });

  it("a local bare remote under the test seam is answered as host local", async () => {
    expect(
      pushTarget({ originUrls: await originUrls(), pushUrls: await pushUrls(), allowFile: true }),
    ).toEqual({
      ok: true,
      target: { host: "local", path: "remote.git" },
    });
  });
});
