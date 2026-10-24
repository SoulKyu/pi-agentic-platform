import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commitOf, type GithubBoxBed, startGithubBoxBed } from "./testing/github-bed.ts";

// Journeys of boxes lot B2, a repository in a box: the guest clones over smart HTTP from the fake GitHub with a box token,
// signs its commit with the key pap registered, pushes, and opens the pull request.

let bed: GithubBoxBed | undefined;
afterEach(async () => {
  await bed?.stop();
  bed = undefined;
});

const claims = (b: GithubBoxBed) =>
  b.fake.state.minted.map((minted) => ({
    ...minted,
    permissions: minted.permissions as Record<string, string>,
  }));

describe("a repository in a box", () => {
  it("clone a repository, the token reaches the guest, a signed commit is pushed, a PR is created", async () => {
    bed = await startGithubBoxBed();
    const repo = bed.fake.state.addRepo("octo/hello");
    await bed.connectApp();
    const project = await bed.cloneProject("octo/hello");

    // The box token: this repository only, contents and pull requests, never administration.
    const tokens = claims(bed).filter((minted) => minted.permissions.contents === "write");
    expect(tokens.length).toBeGreaterThan(0);
    for (const minted of tokens) {
      expect(minted.repositories).toEqual(["octo/hello"]);
      expect(minted.permissions).toEqual({ contents: "write", pull_requests: "write" });
    }
    // The clone went through git over HTTP with that token (the credential helper read it from the guest's /run).
    const fetches = bed.fake.state.callsTo("GIT fetch");
    expect(fetches.length).toBeGreaterThan(0);
    // The first request is anonymous and answered 401; the retry carries the helper's answer.
    expect(fetches.some((call) => /^Basic /.test(call.authorization ?? ""))).toBe(true);
    // The signing key was registered under the project's name, once.
    expect([...bed.fake.state.signingKeys.values()].map((key) => key.title)).toEqual([
      `pap ${project.name} ${project.id.slice(0, 8)}`,
    ]);
    const view = await bed.githubOf(project.id);
    expect(view).toMatchObject({ link: { repository: "octo/hello", fork: false }, key: "added" });

    await bed.writeFile(project, "notes.txt", "from the box\n");
    const pushed = await bed.ask("projects.commitPush", { projectId: project.id, message: "feat: notes" });
    expect(pushed).toMatchObject({ branch: "main" });
    expect(pushed.sha).toMatch(/^[0-9a-f]{40}$/);

    // The bare repository GitHub holds got the commit, signed with an SSH signature, by the owner's noreply identity.
    const commit = commitOf(repo.bare);
    expect(commit).toContain("feat: notes");
    expect(commit).toContain("gpgsig -----BEGIN SSH SIGNATURE-----");
    expect(commit).toMatch(/^author octo <1\+octo@users\.noreply\.github\.com> /m);
    const pushesWithToken = bed.fake.state.callsTo("GIT push");
    expect(pushesWithToken.length).toBeGreaterThan(0);

    // The signature verifies against the public key the owner's account holds, and the private half never sat in a home.
    const publicKey = [...bed.fake.state.signingKeys.values()][0]?.key ?? "";
    const folder = mkdtempSync(join(tmpdir(), "pap-allowed-"));
    try {
      const allowed = join(folder, "allowed");
      writeFileSync(allowed, `1+octo@users.noreply.github.com ${publicKey}\n`);
      const verdict = execFileSync(
        "git",
        ["-C", repo.bare, "-c", `gpg.ssh.allowedSignersFile=${allowed}`, "log", "-1", "--format=%G?", "main"],
        { encoding: "utf8", env: { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null" } },
      ).trim();
      expect(verdict).toBe("G");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
    const privateKeys = bed.filesHolding("BEGIN OPENSSH PRIVATE KEY");
    expect(privateKeys.length).toBeGreaterThan(0);
    for (const path of privateKeys) {
      expect(path).toMatch(/\/boxes\/[0-9a-f-]+\/\.pap\/signing\/pap_signing$/);
    }

    const pr = await bed.ask("projects.prCreate", {
      projectId: project.id,
      title: "Notes",
      body: "adds notes",
    });
    expect(pr).toMatchObject({ kind: "created" });
    expect((pr as { url: string }).url).toMatch(new RegExp(`^${bed.fake.origin}/octo/hello/pull/\\d+$`));
    const created = bed.fake.state.callsTo("POST /repos/:o/:r/pulls");
    expect(created).toHaveLength(1);
    expect(created[0]?.body).toMatchObject({
      title: "Notes",
      body: "adds notes",
      head: "main",
      base: "main",
    });
    // The box has a token that may open pull requests: it came from the fake's own mint.
    // The daemon opened it with a token for this repository that may open pull requests and nothing else, then revoked it.
    const used = claims(bed).find((minted) => `Bearer ${minted.token}` === created[0]?.authorization);
    expect(used).toMatchObject({ permissions: { pull_requests: "write" }, repositories: ["octo/hello"] });
    expect(used?.permissions).toEqual({ pull_requests: "write" });
    expect(bed.fake.state.revoked).toContain(used?.token);
  }, 240_000);

  it("fork a repository, push, the PR answer is the compare URL", async () => {
    bed = await startGithubBoxBed();
    bed.fake.state.addRepo("someone/lib");
    await bed.connectApp();
    const project = await bed.cloneProject("someone/lib", "fork");

    const view = await bed.githubOf(project.id);
    expect(view.link).toEqual({ repository: "octo/lib", upstream: "someone/lib", fork: true });

    await bed.writeFile(project, "fix.txt", "a fix\n");
    await bed.ask("projects.commitPush", { projectId: project.id, message: "fix: it" });
    const answer = await bed.ask("projects.prCreate", { projectId: project.id, title: "Fix", body: "" });
    expect(answer).toEqual({
      kind: "compare",
      url: `${bed.fake.origin}/someone/lib/compare/main...octo:main`,
    });

    // The upstream's API was called once, to fork it; no pull request was created there or anywhere.
    const upstream = bed.fake.state.calls.filter((call) => call.path.startsWith("/repos/someone/lib"));
    expect(upstream.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /repos/someone/lib/forks"]);
    expect(bed.fake.state.callsTo("POST /repos/:o/:r/pulls")).toHaveLength(0);
    // And no git call reached the upstream's repository with a box token.
    expect(bed.fake.state.calls.filter((call) => call.path.startsWith("/someone/lib.git"))).toEqual([]);
    for (const minted of claims(bed))
      expect(minted.repositories.every((name) => name.startsWith("octo/"))).toBe(true);
    await vi.waitFor(() =>
      expect(commitOf(bed?.fake.state.repos.get("octo/lib")?.bare ?? "")).toContain("fix: it"),
    );
  }, 240_000);
});
