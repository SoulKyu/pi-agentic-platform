import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { OWNER } from "./testing/bed.ts";
import { type ProjectsBed, startProjectsBed } from "./testing/projects-bed.ts";

let bed: ProjectsBed;
let id: string;
beforeEach(async () => {
  bed = await startProjectsBed();
  id = bed.create();
  bed.store.put({
    projectId: id,
    ownerId: OWNER,
    repository: "octo/hello",
    upstream: null,
    fork: false,
    cloneState: "done",
  });
});
afterEach(() => bed.close());

const read = async () =>
  (await bed.feature.rpc["projects.github"]({ projectId: id }, { caller: bed.caller } as never)).github;
const data = () => bed.fake.state.data;

describe("lists", () => {
  it("PRs carry check states", async () => {
    data().pulls.set("octo/hello", [
      {
        number: 3,
        title: "Fix",
        html_url: "https://x/3",
        user: { login: "ann" },
        draft: false,
        head: { ref: "fix", sha: "s1" },
      },
    ]);
    data().checkRuns.set("octo/hello@s1", [
      { id: 11, name: "build", status: "completed", conclusion: "failure" },
      { id: 12, name: "lint", status: "completed", conclusion: "success" },
      { id: 13, name: "e2e", status: "in_progress", conclusion: null },
      { id: 14, name: "docs", status: "completed", conclusion: "skipped" },
    ]);
    const { pulls } = await read();
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({ number: 3, author: "ann", headRef: "fix" });
    expect(pulls[0]?.checks.map((c) => [c.id, c.state])).toEqual([
      ["11", "failure"],
      ["12", "success"],
      ["13", "running"],
      ["14", "neutral"],
    ]);
    expect(bed.fake.state.minted.at(-1)?.permissions).toEqual({
      contents: "read",
      pull_requests: "read",
      issues: "read",
      checks: "read",
      actions: "read",
      metadata: "read",
    });
  });

  it("issues drop pull requests", async () => {
    data().issues.set("octo/hello", [
      { number: 1, title: "Bug", html_url: "https://x/1", user: { login: "bob" }, labels: [{ name: "bug" }] },
      { number: 2, title: "A PR", html_url: "https://x/2", user: { login: "bob" }, pull_request: {} },
    ]);
    data().releases.set("octo/hello", [
      {
        tag_name: "v1",
        name: null,
        published_at: "2026-01-01T00:00:00Z",
        html_url: "https://x/r",
        assets: [{ name: "a.zip", browser_download_url: "https://x/a.zip" }],
      },
    ]);
    const view = await read();
    expect(view.issues).toEqual([
      { number: 1, title: "Bug", url: "https://x/1", author: "bob", labels: ["bug"] },
    ]);
    expect(view.releases[0]).toMatchObject({ tag: "v1", name: "v1", assets: [{ name: "a.zip" }] });
    expect(view.link).toMatchObject({ repository: "octo/hello" });
  });

  it("the cache holds 60 s and a failure answers the stale lists", async () => {
    const first = await read();
    const calls = () => bed.fake.state.callsTo("GET /repos/:o/:r/pulls").length;
    expect(calls()).toBe(1);
    await bed.clock.advance(59_000);
    await read();
    expect(calls()).toBe(1);
    await bed.clock.advance(2_000);
    await read();
    expect(calls()).toBe(2);
    bed.fake.state.fail("GET /repos/:o/:r/pulls", 500);
    await bed.clock.advance(61_000);
    const stale = await read();
    expect(stale.fetchedAt).not.toBe(first.fetchedAt);
    expect(stale.fetchedAt).toBe((await read()).fetchedAt);
  });

  it("a relink to another repository never shows the old lists", async () => {
    data().issues.set("octo/hello", [
      { number: 1, title: "Old", html_url: "https://x/1", user: { login: "a" } },
    ]);
    expect((await read()).issues).toHaveLength(1);
    bed.fake.state.addRepo("octo/other");
    bed.store.put({
      projectId: id,
      ownerId: OWNER,
      repository: "octo/other",
      upstream: null,
      fork: false,
      cloneState: "done",
    });
    expect((await read()).issues).toEqual([]);
  });

  it("without a cache a failure is github_unavailable; a token may read; others' projects are not found", async () => {
    bed.fake.state.fail("GET /repos/:o/:r/pulls", 500);
    await expect(read()).rejects.toMatchObject({ code: "github_unavailable" });
    bed.fake.state.respond("GET /repos/:o/:r/pulls", { status: 200, body: [] }, 0);
    const token = testCaller({ userId: OWNER, kind: "token" });
    await expect(
      bed.feature.rpc["projects.github"]({ projectId: id }, { caller: token } as never),
    ).resolves.toBeDefined();
    const other = testCaller({ userId: "someone-else" });
    await expect(
      bed.feature.rpc["projects.github"]({ projectId: id }, { caller: other } as never),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
