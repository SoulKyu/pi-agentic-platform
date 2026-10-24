import { describe, expect, it } from "vitest";
import { BOX_OP_RESULTS, BOX_OP_TIMEOUTS, BoxOp } from "./boxes.ts";
import { BOX_GITHUB_OPS, GitRemoteUrl } from "./box-github-ops.ts";

const SAMPLES: Record<string, Record<string, unknown>> = {
  "git.clone": { url: "https://github.com/octo/repo.git", upstream: null },
  "git.link": { url: "https://github.com/octo/repo.git" },
  "git.unlink": {},
  "git.commit": { message: "feat: x" },
  "git.push": {},
  "github.token": { token: "ghs_abc", expiresAt: "2026-10-24T10:00:00Z" },
  "github.identity": { login: "octo", displayName: "octo", email: "1+octo@users.noreply.github.com" },
  "github.forgetKey": {},
};

describe("the GitHub guest ops", () => {
  it("each op refuses unknown keys", () => {
    for (const [name, params] of Object.entries(SAMPLES)) {
      expect(BoxOp.safeParse({ name, ...params }).success, name).toBe(true);
      expect(BoxOp.safeParse({ name, ...params, extra: 1 }).success, `${name} + extra`).toBe(false);
    }
    expect(BOX_GITHUB_OPS.map((o) => o.shape.name.value).sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  it("a clone url must be https github or the test origin", () => {
    const good = [
      "https://github.com/octo/repo.git",
      "http://127.0.0.1:8123/octo/repo.git",
      "file:///tmp/pap-fake/octo__repo.git",
    ];
    const bad = [
      "http://github.com/octo/repo.git",
      "https://github.com.evil.test/octo/repo.git",
      "https://github.com/octo/repo",
      "https://github.com/octo/../repo.git",
      "ssh://git@github.com/octo/repo.git",
      "http://10.213.0.1:80/octo/repo.git",
      "file:///tmp/../etc/passwd",
      "-oProxyCommand=x",
    ];
    for (const url of good) expect(GitRemoteUrl.safeParse(url).success, url).toBe(true);
    for (const url of bad) expect(GitRemoteUrl.safeParse(url).success, url).toBe(false);
  });

  it("bounds the commit message and the push of a token", () => {
    expect(BoxOp.safeParse({ name: "git.commit", message: "x".repeat(4097) }).success).toBe(false);
    expect(BoxOp.safeParse({ name: "github.token", token: "has space", expiresAt: "x" }).success).toBe(false);
  });

  it("no op runs gh: pull requests are opened by the daemon (R9)", () => {
    expect(BoxOp.safeParse({ name: "gh.prCreate", title: "t", body: "", base: "main" }).success).toBe(false);
    expect(Object.keys(BOX_OP_RESULTS)).not.toContain("gh.prCreate");
  });

  it("the timeouts table names every op", () => {
    expect(Object.keys(BOX_OP_TIMEOUTS).sort()).toEqual(Object.keys(BOX_OP_RESULTS).sort());
    expect(BOX_OP_TIMEOUTS["git.clone"]).toBe(600_000);
    expect(BOX_OP_TIMEOUTS["git.push"]).toBe(120_000);
    expect(BOX_OP_TIMEOUTS["fs.read"]).toBe(30_000);
    expect(BOX_OP_TIMEOUTS["github.token"]).toBe(30_000);
  });
});
