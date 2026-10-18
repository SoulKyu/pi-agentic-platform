import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgeEnv } from "../../apps/daemon/src/kernel/forge/cli.ts";
import { githubArgs } from "../../apps/daemon/src/kernel/forge/github.ts";
import type { RemoteRef } from "../../apps/daemon/src/kernel/forge/remote.ts";
import { FORGE_URL, GH_STUB_DIR, ghCalls, laneEnv, makeBareRemote, gitIn } from "./git.ts";

const REPO: RemoteRef = { host: "github.com", path: "test/repo" };
let home: string;
beforeEach(() => void (home = mkdtempSync(join(tmpdir(), "pap-e2e-git-test-"))));
afterEach(() => rmSync(home, { recursive: true, force: true }));

// The environment the daemon gives the forge CLI: `forgeEnv` over the daemon's own, whose PATH starts with the stub folder.
const forge = () => forgeEnv({ HOME: home, PATH: laneEnv()["PATH"] }, join(home, "forge"));
const gh = (args: string[], input = "") => spawnSync("gh", args, { env: forge(), input, encoding: "utf8" });
const PR_URL = "https://example.invalid/e2e/pull/1";

describe("the gh stub answers the argv the daemon's builders produce", () => {
  it("is found through the PATH that unattendedEnv keeps, and logs the call", () => {
    expect(forge()["PATH"]?.split(":")[0]).toBe(GH_STUB_DIR);
    const answer = gh(githubArgs.prFind(REPO, "pi/e2e-lane"));
    expect(answer.status).toBe(0);
    expect(ghCalls({ userHome: home })).toEqual([`call ${githubArgs.prFind(REPO, "pi/e2e-lane").join(" ")}`]);
  });

  it("lists no pull request first", () => {
    const answer = gh(githubArgs.prFind(REPO, "pi/e2e-lane"));
    expect(JSON.parse(answer.stdout)).toEqual([]);
  });

  it("creates with the body on stdin and prints a URL under example.invalid", () => {
    for (const draft of [false, true]) {
      for (const base of ["main", undefined]) {
        const args = githubArgs.prCreate(REPO, "pi/e2e-lane", base, "Add the lane file", draft);
        const answer = gh(args, "Body\nof it");
        expect({ args, status: answer.status, out: answer.stdout.trim() }).toEqual({
          args,
          status: 0,
          out: PR_URL,
        });
      }
    }
    expect(ghCalls({ userHome: home }).filter((line) => line.startsWith("stdin "))).toEqual(
      Array(4).fill("stdin Body of it"),
    );
  });

  it("views pull request 1 with passing checks and issue n with its fields", () => {
    const pr = JSON.parse(gh(githubArgs.prView(REPO, 1)).stdout) as Record<string, unknown>;
    expect(pr).toMatchObject({
      number: 1,
      url: PR_URL,
      state: "OPEN",
      isDraft: false,
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    });
    const issue = JSON.parse(gh(githubArgs.issueView(REPO, 7)).stdout) as Record<string, unknown>;
    expect(issue).toMatchObject({ number: 7, state: "OPEN", labels: [] });
  });

  it("exits 2 for anything else, and still logs it", () => {
    const strange: string[][] = [
      ["auth", "status"],
      ["repo", "view", "--repo=github.com/test/repo"],
      githubArgs.prView(REPO, 2),
      githubArgs.prFind({ host: "github.com", path: "test/other" }, "pi/e2e-lane"),
      [...githubArgs.prFind(REPO, "pi/e2e-lane"), "--token=secret"],
      [],
    ];
    for (const args of strange) expect({ args, status: gh(args).status }).toEqual({ args, status: 2 });
    expect(ghCalls({ userHome: home })).toHaveLength(strange.length);
  });
});

describe("makeBareRemote", () => {
  it("points origin at the forge URL and rewrites it to the bare repository", async () => {
    const work = join(home, "work");
    execFileSync("git", ["init", "-q", "-b", "main", work]);
    const bare = await makeBareRemote({ userHome: home, work });
    expect(gitIn({ userHome: home }, work, "config", "remote.origin.url").trim()).toBe(FORGE_URL);
    expect(gitIn({ userHome: home }, work, "ls-remote", "--get-url", "origin").trim()).toBe(`file://${bare}`);
    expect(readFileSync(join(home, ".gitconfig"), "utf8")).toContain(`insteadOf = ${FORGE_URL}`);
    expect(bare.startsWith(home)).toBe(true);
  });
});
