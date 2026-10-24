import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GITHUB_HOSTS } from "./projects.ts";
import { eventually, type ProjectsBed, startProjectsBed } from "./testing/projects-bed.ts";

let bed: ProjectsBed;
beforeEach(async () => {
  bed = await startProjectsBed();
});
afterEach(() => bed.close());

const link = (projectId: string) =>
  bed.feature.service.linkGithub(bed.caller, { projectId, repository: "octo/hello" });

describe("linkGithub", () => {
  it("links an existing box project: origin in the box, hosts, token, identity, key", async () => {
    const id = bed.create("notes");
    bed.control.setPhase(id, "running");
    const view = await link(id);
    expect(view).toMatchObject({
      link: { repository: "octo/hello", upstream: null, fork: false },
      key: "added",
      clone: null,
      pulls: [],
      issues: [],
      releases: [],
    });
    expect(bed.ops.calls[0]?.op).toEqual({ name: "git.link", url: `${bed.fake.origin}/octo/hello.git` });
    expect(bed.opNames()).toEqual(["git.link", "github.token", "github.identity"]);
    expect(bed.projects.boxSource.box(id)?.hosts).toEqual([...GITHUB_HOSTS]);
    expect(bed.fake.state.signingKeys.size).toBe(1);
    expect([...bed.fake.state.signingKeys.values()][0]?.title).toBe(`pap notes ${id.slice(0, 8)}`);
  });

  it("answers box_stopped for a stopped box, conflict for a linked one, not_found for another's", async () => {
    const id = bed.create();
    await expect(link(id)).rejects.toMatchObject({ code: "box_stopped" });
    expect(bed.store.get(id)).toBeUndefined();
    bed.control.setPhase(id, "running");
    await link(id);
    await expect(link(id)).rejects.toMatchObject({ code: "conflict" });
    await expect(
      bed.feature.service.linkGithub(
        { ...bed.caller, userId: "someone-else" },
        { projectId: id, repository: "octo/hello" },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses a repository the App cannot reach before touching the box", async () => {
    const id = bed.create();
    bed.control.setPhase(id, "running");
    bed.fake.state.fail("GET /repos/:o/:r/installation", 404);
    await expect(link(id)).rejects.toMatchObject({ code: "not_found" });
    expect(bed.ops.calls).toEqual([]);
    expect(bed.store.get(id)).toBeUndefined();
  });

  it("links again after an unlink", async () => {
    const id = bed.create();
    bed.control.setPhase(id, "running");
    await link(id);
    await bed.feature.service.unlinkGithub(bed.caller, id);
    expect(bed.store.get(id)).toBeUndefined();
    expect(await link(id)).toMatchObject({ link: { repository: "octo/hello" }, key: "added" });
    await eventually(() => expect(bed.fake.state.signingKeys.size).toBe(1));
  });

  it("unlink needs a running box and a linked project", async () => {
    const id = bed.create();
    await expect(bed.feature.service.unlinkGithub(bed.caller, id)).rejects.toMatchObject({
      code: "not_found",
    });
    bed.control.setPhase(id, "running");
    await link(id);
    bed.control.setPhase(id, "stopped");
    await expect(bed.feature.service.unlinkGithub(bed.caller, id)).rejects.toMatchObject({
      code: "box_stopped",
    });
    expect(bed.store.get(id)?.linked).toBe(true);
  });
});
