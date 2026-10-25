import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { ACCESS_TTL_MS } from "./access.ts";
import { RENEW_MS } from "./deliver.ts";
import { OWNER } from "./testing/bed.ts";
import { connectUser } from "./testing/members.ts";
import { eventually, type ProjectsBed, startProjectsBed } from "./testing/projects-bed.ts";

const MEMBER = "member-1";
let bed: ProjectsBed;
let ownerToken: string;
let memberToken: string;
beforeEach(async () => {
  bed = await startProjectsBed();
  ownerToken = bed.fake.state.userTokens.access;
  memberToken = await connectUser(bed.fake, bed.core.userTokens, MEMBER, "member");
  bed.fake.state.addRepo("octo/secret", { private: true });
  bed.fake.state.access.restrict("octo/secret", { [ownerToken]: "push" });
});
afterEach(() => bed.close());

const member = () => testCaller({ userId: MEMBER });
const service = () => bed.feature.service;
const noMint = () => {
  expect(bed.fake.state.minted).toEqual([]);
  expect(bed.fake.state.callsTo("POST /app/installations")).toEqual([]);
};

describe("a project's repository is one its owner's own token pushes to", () => {
  it("a member cannot clone or link a repository only the owner's installation reaches", async () => {
    await expect(
      service().createFromGithub(member(), { repository: "octo/secret", mode: "clone" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(bed.projects.port.all(MEMBER)).toEqual([]);
    noMint();
    // The App's own lookup (its JWT reaches every installation) never ran: the member's token is asked first.
    expect(bed.fake.state.callsTo("GET /repos/:o/:r/installation")).toEqual([]);

    const id = bed.projects.create(member(), "mine").id;
    bed.control.setPhase(id, "running");
    await expect(
      service().linkGithub(member(), { projectId: id, repository: "octo/secret" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(bed.store.get(id)).toBeUndefined();
    expect(bed.opNames()).toEqual([]);
    noMint();
    expect(bed.fake.state.callsTo("GET /repos/:o/:r/installation")).toEqual([]);
  });

  it("a collaborator with push clones and links it", async () => {
    bed.fake.state.access.restrict("octo/secret", { [ownerToken]: "push", [memberToken]: "push" });
    const { project } = await service().createFromGithub(member(), {
      repository: "octo/secret",
      mode: "clone",
    });
    expect(bed.store.get(project.id)).toMatchObject({ repository: "octo/secret", ownerId: MEMBER });

    const id = bed.projects.create(member(), "mine").id;
    bed.control.setPhase(id, "running");
    const view = await service().linkGithub(member(), { projectId: id, repository: "octo/secret" });
    expect(view.link?.repository).toBe("octo/secret");
  });

  it("a read-only collaborator is refused", async () => {
    bed.fake.state.access.restrict("octo/secret", { [memberToken]: "pull" });
    await expect(
      service().createFromGithub(member(), { repository: "octo/secret", mode: "clone" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(bed.projects.port.all(MEMBER)).toEqual([]);
    noMint();
  });

  it("the owner is checked the same way", async () => {
    bed.fake.state.access.restrict("octo/secret", {});
    await expect(
      service().createFromGithub(bed.caller, { repository: "octo/secret", mode: "clone" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(bed.projects.port.all(OWNER)).toEqual([]);
    noMint();
  });

  it("fork mode forks with the member's own token and reads nothing of the owner's", async () => {
    bed.fake.state.addRepo("acme/lib");
    const { project } = await service().createFromGithub(member(), { repository: "acme/lib", mode: "fork" });
    expect(bed.store.get(project.id)).toMatchObject({ fork: true, ownerId: MEMBER });
    const forks = bed.fake.state.callsTo("POST /repos/:o/:r/forks");
    expect(forks).toHaveLength(1);
    expect(forks[0]?.authorization).toBe(`Bearer ${memberToken}`);
  });

  it("a member cannot fork a repository they cannot read", async () => {
    bed.fake.state.addRepo("acme/vault", { private: true });
    bed.fake.state.access.restrict("acme/vault", { [ownerToken]: "pull" });
    await expect(
      service().createFromGithub(member(), { repository: "acme/vault", mode: "fork" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(bed.projects.port.all(MEMBER)).toEqual([]);
    // The fork is asked with the member's own token and answers 404: no copy (octo/vault in the fake) exists.
    const forks = bed.fake.state.callsTo("POST /repos/:o/:r/forks");
    expect(forks.map((call) => call.authorization)).toEqual([`Bearer ${memberToken}`]);
    expect(bed.fake.state.repos.has("octo/vault")).toBe(false);
    noMint();
  });

  it("deliver stops minting once the owner's access is gone, after the cache expires", async () => {
    const { project } = await service().createFromGithub(bed.caller, {
      repository: "octo/hello",
      mode: "clone",
    });
    bed.control.setPhase(project.id, "running");
    await eventually(() => expect(bed.store.get(project.id)?.cloneState).toBe("done"));
    expect(bed.fake.state.minted).toHaveLength(1);
    // The create call asked GitHub; the start two seconds later used the cached decision.
    expect(bed.fake.state.calls.filter((call) => call.route === "GET /repos/:o/:r")).toHaveLength(1);

    bed.fake.state.access.restrict("octo/hello", {});
    await bed.clock.advance(RENEW_MS);
    await eventually(() => expect(bed.lines.some((line) => line.msg === "github_access_lost")).toBe(true));
    expect(bed.fake.state.minted).toHaveLength(1);
    expect(bed.fake.state.revoked).toHaveLength(1);
    expect(RENEW_MS).toBeGreaterThan(ACCESS_TTL_MS);
  });

  it("a rate-limited check at the renewal keeps the last decision", async () => {
    const { project } = await service().createFromGithub(bed.caller, {
      repository: "octo/hello",
      mode: "clone",
    });
    bed.control.setPhase(project.id, "running");
    await eventually(() => expect(bed.store.get(project.id)?.cloneState).toBe("done"));

    bed.fake.state.fail("GET /repos/:o/:r", 429, "slow down", 1);
    await bed.clock.advance(RENEW_MS);
    await eventually(() => expect(bed.fake.state.minted).toHaveLength(2));
    expect(bed.lines.some((line) => line.msg === "github_access_lost")).toBe(false);
  });
});
