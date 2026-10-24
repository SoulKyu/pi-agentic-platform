import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { OWNER } from "./testing/bed.ts";
import { eventually, type ProjectsBed, startProjectsBed } from "./testing/projects-bed.ts";
import { FORK_POLLS, GITHUB_HOSTS } from "./projects.ts";

let bed: ProjectsBed;
beforeEach(async () => {
  bed = await startProjectsBed();
});
afterEach(() => bed.close());

const service = () => bed.feature.service;

describe("createFromGithub", () => {
  it("clone creates the project, the row and the host preset", async () => {
    const { project } = await service().createFromGithub(bed.caller, {
      repository: "octo/hello",
      mode: "clone",
    });
    expect(project).toMatchObject({ kind: "box", name: "hello", root: `/boxes/${project.id}/project` });
    expect(bed.store.get(project.id)).toMatchObject({
      repository: "octo/hello",
      upstream: null,
      fork: false,
      linked: true,
      cloneState: "pending",
      cloneError: null,
    });
    expect(bed.projects.boxSource.box(project.id)?.hosts).toEqual([...GITHUB_HOSTS]);
    expect(bed.fake.state.callsTo("POST /repos/:o/:r/forks")).toEqual([]);
    // Nothing starts the box: the clone waits for its first start.
    expect(bed.control.calls).toEqual([]);
    expect(bed.ops.calls).toEqual([]);
    expect(bed.audit.map((row) => row.reason)).toContain("project_github_cloned");
  });

  it("names the project from the request when given", async () => {
    const { project } = await service().createFromGithub(bed.caller, {
      repository: "octo/hello",
      mode: "clone",
      name: "My copy",
    });
    expect(project.name).toBe("My copy");
  });

  it("fork waits for the fork then clones it with upstream", async () => {
    bed.fake.state.addRepo("acme/lib");
    // The fork answers `404` twice before it exists for the owner.
    bed.fake.state.fail("GET /repos/:o/:r", 404, "not yet", 2);
    const { project } = await service().createFromGithub(bed.caller, {
      repository: "acme/lib",
      mode: "fork",
    });
    expect(bed.sleeps).toEqual([2000, 2000]);
    expect(bed.fake.state.callsTo("POST /repos/:o/:r/forks")).toHaveLength(1);
    expect(bed.store.get(project.id)).toMatchObject({
      repository: "octo/lib",
      upstream: "acme/lib",
      fork: true,
      cloneState: "pending",
    });
    expect(project.name).toBe("lib");

    bed.control.setPhase(project.id, "running");
    await eventually(() => expect(bed.opNames()).toContain("git.clone"));
    const clone = bed.ops.all.find((call) => call.op.name === "git.clone")?.op;
    expect(clone).toEqual({
      name: "git.clone",
      url: `${bed.fake.origin}/octo/lib.git`,
      upstream: `${bed.fake.origin}/acme/lib.git`,
    });
    // The box token is minted for the fork, never the upstream.
    expect(bed.fake.state.minted.map((minted) => minted.repositories)).toEqual([["octo/lib"]]);
  });

  it("a refused fork leaves nothing behind: no capacity, no installation, no App", async () => {
    bed.fake.state.addRepo("acme/lib");
    const forks = () => bed.fake.state.callsTo("POST /repos/:o/:r/forks");
    bed.fake.state.respond("GET /user/installations", { status: 200, body: { installations: [] } });
    await expect(
      service().createFromGithub(bed.caller, { repository: "acme/lib", mode: "fork" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(forks()).toEqual([]);

    bed.fake.state.respond("GET /user/installations", { status: 200, body: { installations: [] } }, 0);
    vi.spyOn(bed.projects, "hasRoom").mockReturnValue(false);
    await expect(
      service().createFromGithub(bed.caller, { repository: "acme/lib", mode: "fork" }),
    ).rejects.toMatchObject({ code: "capacity" });
    expect(forks()).toEqual([]);
  });

  it("a fork that never appears fails cleanly", async () => {
    bed.fake.state.addRepo("acme/lib");
    bed.fake.state.fail("GET /repos/:o/:r", 404, "never");
    await expect(
      service().createFromGithub(bed.caller, { repository: "acme/lib", mode: "fork" }),
    ).rejects.toMatchObject({ code: "github_unavailable" });
    expect(bed.sleeps).toHaveLength(FORK_POLLS);
    expect(bed.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(60_000);
    expect(bed.projects.port.all(OWNER)).toEqual([]);
    expect(bed.lines.some((line) => line.msg === "github_fork_timeout")).toBe(true);
  });

  it("the App cannot reach the repository → the named GitHub step", async () => {
    bed.fake.state.fail("GET /repos/:o/:r/installation", 404);
    await expect(
      service().createFromGithub(bed.caller, { repository: "octo/hello", mode: "clone" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(bed.projects.port.all(OWNER)).toEqual([]);
    expect(bed.ops.calls).toEqual([]);
  });

  it("without an App, or without a connected user for a fork, it is github_unavailable", async () => {
    bed.core.userTokens.clear(OWNER);
    bed.fake.state.addRepo("acme/lib");
    await expect(
      service().createFromGithub(bed.caller, { repository: "acme/lib", mode: "fork" }),
    ).rejects.toMatchObject({ code: "github_unavailable" });
    bed.core.appSecrets.forget();
    await expect(
      service().createFromGithub(bed.caller, { repository: "octo/hello", mode: "clone" }),
    ).rejects.toMatchObject({ code: "github_unavailable" });
    expect(bed.projects.port.all(OWNER)).toEqual([]);
  });

  it("a token caller is forbidden on every browser-only call", async () => {
    const token = testCaller({ kind: "token", userId: OWNER });
    const id = bed.create();
    const before = bed.fake.state.calls.length;
    const calls = [
      service().repositories(token, undefined),
      service().createFromGithub(token, { repository: "octo/hello", mode: "clone" }),
      service().linkGithub(token, { projectId: id, repository: "octo/hello" }),
      service().unlinkGithub(token, id),
      service().cloneAgain(token, id),
    ];
    for (const call of calls) await expect(call).rejects.toMatchObject({ code: "forbidden" });
    expect(bed.fake.state.calls).toHaveLength(before);
  });
});

describe("repositories", () => {
  it("lists the repositories of the installations, filtered by the query", async () => {
    bed.fake.state.addRepo("octo/other", { private: true });
    const all = await service().repositories(bed.caller, undefined);
    expect(all.repositories.map((repo) => repo.fullName).sort()).toEqual(["octo/hello", "octo/other"]);
    const some = await service().repositories(bed.caller, "OTH");
    expect(some.repositories).toEqual([{ fullName: "octo/other", private: true, defaultBranch: "main" }]);
    expect(JSON.stringify(all)).not.toContain("ghu_");
  });
});
