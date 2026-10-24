import { afterEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { OWNER } from "./testing/bed.ts";
import { type ProjectsBed, startProjectsBed } from "./testing/projects-bed.ts";

let bed: ProjectsBed;
afterEach(() => bed.close());

const handlers = {
  "git.commit": () => ({ sha: "abc1234" as string | null }),
  "git.push": () => ({ branch: "feat/x", remote: "origin" }),
};
const link = (repository: "octo/hello" | "octo/lib", upstream: "acme/lib" | null = null): string => {
  const id = bed.create();
  bed.store.put({
    projectId: id,
    ownerId: OWNER,
    repository,
    upstream,
    fork: upstream !== null,
    cloneState: "done",
  });
  return id;
};
const actions = () => bed.feature.rpc;

describe("commit and push", () => {
  it("commit and push through the box", async () => {
    bed = await startProjectsBed(handlers);
    const id = link("octo/hello");
    const out = await actions()["projects.commitPush"]({ projectId: id, message: "feat: x" }, ctx());
    expect(out).toEqual({ sha: "abc1234", branch: "feat/x" });
    expect(bed.opNames()).toEqual(["git.commit", "git.push"]);
    expect(bed.audit.find((row) => row.reason === "github_pushed")).toBeDefined();
  });

  it("pushes anyway when there was nothing to commit", async () => {
    bed = await startProjectsBed({ ...handlers, "git.commit": () => ({ sha: null }) });
    const id = link("octo/hello");
    const out = await actions()["projects.commitPush"]({ projectId: id, message: "m" }, ctx());
    expect(out).toEqual({ sha: null, branch: "feat/x" });
    expect(bed.opNames()).toEqual(["git.commit", "git.push"]);
  });

  it("refuses a token caller and an unlinked project", async () => {
    bed = await startProjectsBed(handlers);
    const id = link("octo/hello");
    const token = testCaller({ userId: OWNER, kind: "token" });
    await expect(
      actions()["projects.commitPush"]({ projectId: id, message: "m" }, { caller: token } as never),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      actions()["projects.commitPush"]({ projectId: bed.create("bare"), message: "m" }, ctx()),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(bed.opNames()).toEqual([]);
  });
});

describe("pull request", () => {
  it("the daemon opens the pull request: pushed branch as head, default branch as base, a pull_requests-only token", async () => {
    bed = await startProjectsBed(handlers);
    const id = link("octo/hello");
    const out = await actions()["projects.prCreate"]({ projectId: id, title: "t", body: "b" }, ctx());
    expect(out).toEqual({
      kind: "created",
      number: expect.any(Number),
      url: expect.stringMatching(/\/octo\/hello\/pull\/\d+$/),
    });
    expect(bed.opNames()).toEqual(["git.push"]);
    const post = bed.fake.state.callsTo("POST /repos/:o/:r/pulls");
    expect(post).toHaveLength(1);
    expect(post[0]?.path).toBe("/repos/octo/hello/pulls");
    expect(post[0]?.body).toEqual({ title: "t", body: "b", head: "feat/x", base: "main" });
    const used = bed.fake.state.minted.find((m) => post[0]?.authorization === `Bearer ${m.token}`);
    expect(used).toMatchObject({ permissions: { pull_requests: "write" }, repositories: ["octo/hello"] });
    expect(bed.fake.state.revoked).toContain(used?.token);
    expect(bed.audit.find((row) => row.reason === "github_pr_created")).toBeDefined();
  });

  it("a given base is used as is", async () => {
    bed = await startProjectsBed(handlers);
    const id = link("octo/hello");
    await actions()["projects.prCreate"]({ projectId: id, title: "t", body: "b", base: "release" }, ctx());
    expect(bed.fake.state.callsTo("POST /repos/:o/:r/pulls")[0]?.body).toMatchObject({ base: "release" });
  });

  it("a pull request that already exists is a conflict, and GitHub's words never reach the caller", async () => {
    bed = await startProjectsBed(handlers);
    const id = link("octo/hello");
    await actions()["projects.prCreate"]({ projectId: id, title: "t", body: "b" }, ctx());
    const open = actions()["projects.prCreate"];
    const again = await open({ projectId: id, title: "t", body: "b" }, ctx()).catch(
      (error: unknown) => error,
    );
    expect(again).toMatchObject({ code: "conflict" });
    expect(JSON.stringify(again)).not.toContain("secret-branch");
    expect(String((again as Error).message)).not.toContain("secret-branch");
    expect(JSON.stringify(bed.lines)).not.toContain("secret-branch");
  });

  it("a fork answers the compare URL and calls no upstream API", async () => {
    bed = await startProjectsBed(handlers);
    bed.fake.state.addRepo("octo/lib");
    bed.fake.state.respond("GET /repos/:o/:r", {
      status: 200,
      body: { full_name: "octo/lib", default_branch: "main", parent: { default_branch: "trunk" } },
    });
    const id = link("octo/lib", "acme/lib");
    const out = await actions()["projects.prCreate"]({ projectId: id, title: "t", body: "b" }, ctx());
    expect(out).toEqual({
      kind: "compare",
      url: `${bed.fake.origin}/acme/lib/compare/trunk...octo:feat/x`,
    });
    expect(bed.opNames()).toEqual(["git.push"]);
    expect(bed.fake.state.calls.filter((call) => call.path.includes("acme/"))).toEqual([]);
    expect(bed.fake.state.minted.every((m) => m.repositories.every((r) => r === "octo/lib"))).toBe(true);
  });
});

function ctx() {
  return { caller: bed.caller } as never;
}
