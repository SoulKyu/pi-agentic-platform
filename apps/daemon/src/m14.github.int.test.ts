import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProjectView } from "@pap/contracts";
import { rows } from "./security/testing/automation-bed.ts";
import { type GithubBoxBed, startGithubBoxBed } from "./testing/github-bed.ts";
import { httpRequest } from "./testing/http-client.ts";
import { addMember, ownerOf, type Person } from "./testing/two-users.ts";

// M14 J1, GitHub: the App is the owner's, and each user's repositories are the ones their own GitHub token reaches with push.
// A member connects their own account; a member's box is cloned and minted for them; a repository only the owner's token
// reaches is never theirs (the App's JWT reaches every installation, so the check is the user's token, never the App's).

let bed: GithubBoxBed;
let owner: Person;
let member: Person;
let ownerAccess = "";
let memberAccess = "";
beforeAll(async () => {
  bed = await startGithubBoxBed({ steps: Array.from({ length: 6 }, () => ({ text: "ok" })) });
  bed.fake.state.addRepo("octo/shared");
  bed.fake.state.addRepo("octo/secret");
  await bed.connectApp();
  ownerAccess = bed.fake.state.userTokens.access;
  // Only the owner's user token reaches this one, as with a repository of a private organisation.
  bed.fake.state.access.restrict("octo/secret", { [ownerAccess]: "push" });
  owner = await ownerOf(bed);
  member = await addMember(bed, "mia");
  await connectAs(member, "member-code");
  memberAccess = bed.fake.state.userTokens.access;
}, 240_000);
afterAll(async () => bed?.stop());

/** The member's own sign-in at GitHub: the callback has no cookie, the finish carries the member's. */
async function connectAs(who: Person, code: string): Promise<void> {
  const frame = await who.call("github.authorizeUrl", {});
  if (!frame.ok) throw new Error(`authorizeUrl: ${frame.error.code}`);
  const state = new URL((frame.result as { url: string }).url).searchParams.get("state");
  const back = await httpRequest(`${bed.t.base}/github/app/authorized?code=${code}&state=${state}`);
  const ticket = /finish\?ticket=([0-9a-f]{32})/.exec(back.body)?.[1];
  if (back.status !== 200 || ticket === undefined) throw new Error(`callback ${back.status}`);
  const done = await who.http(`/github/app/authorized/finish?ticket=${ticket}`);
  if (done.status !== 200) throw new Error(`finish ${done.status}`);
}

const repoCalls = (name: string) => bed.fake.state.calls.filter((call) => call.path === `/repos/${name}`);

describe("a member and GitHub", () => {
  it("a member's box is cloned and minted for the member: their token decides, never the owner's", async () => {
    expect(memberAccess).not.toBe(ownerAccess);
    const made = await member.call("projects.createFromGithub", {
      repository: "octo/shared" as never,
      mode: "clone",
    });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const project = (made.ok ? (made.result as { project: ProjectView }).project : null) as ProjectView;
    const started = await member.call("projects.startBox", { projectId: project.id });
    expect(started.ok).toBe(true);
    // The access check for the member's clone ran with the member's user token.
    const asked = repoCalls("octo/shared").map((call) => call.authorization);
    expect(asked).toContain(`Bearer ${memberAccess}`);
    expect(asked).not.toContain(`Bearer ${ownerAccess}`);
    // The box token was minted for this repository alone, without administration.
    // The box token is minted as the box comes up.
    await vi.waitFor(() =>
      expect(bed.fake.state.minted.some((one) => one.repositories.includes("octo/shared"))).toBe(true),
    );
    const minted = bed.fake.state.minted.filter((one) => one.repositories.includes("octo/shared"));
    for (const one of minted) expect(one.repositories).toEqual(["octo/shared"]);
    // It is the member's project: the owner does not see it, and has no clone of it.
    const projects = await owner.call("projects.github", { projectId: project.id });
    expect(projects.ok ? "ok" : projects.error.code).toBe("not_found");
  }, 240_000);

  it("a member cannot reach the owner's repository: no project row, no token minted for it", async () => {
    const before = bed.fake.state.minted.length;
    const projectsBefore = rows<{ n: number }>(bed.t.home, "SELECT count(*) AS n FROM projects")[0]?.n;
    const clone = await member.call("projects.createFromGithub", {
      repository: "octo/secret" as never,
      mode: "clone",
    });
    expect(clone.ok ? "ok" : clone.error.code).toBe("not_found");
    const fork = await member.call("projects.createFromGithub", {
      repository: "octo/secret" as never,
      mode: "fork",
    });
    expect(fork.ok ? "ok" : fork.error.code).toBe("not_found");
    // Linking one of the member's own projects to it is refused the same way.
    const own = await member.call("projects.create", { name: "Mine" });
    const mine = (own.ok ? (own.result as { project: ProjectView }).project : null) as ProjectView;
    expect((await member.call("projects.startBox", { projectId: mine.id })).ok).toBe(true);
    const link = await member.call("projects.linkGithub", {
      projectId: mine.id,
      repository: "octo/secret" as never,
    });
    expect(link.ok ? "ok" : link.error.code).toBe("not_found");
    expect(rows<{ n: number }>(bed.t.home, "SELECT count(*) AS n FROM projects")[0]?.n).toBe(
      (projectsBefore ?? 0) + 1,
    );
    // The member's token was the one asked, it answered no, and nothing was minted for the repository, ever.
    expect(repoCalls("octo/secret").some((call) => call.authorization === `Bearer ${memberAccess}`)).toBe(
      true,
    );
    expect(bed.fake.state.minted.slice(before).flatMap((one) => one.repositories)).not.toContain(
      "octo/secret",
    );
    expect(bed.fake.state.minted.flatMap((one) => one.repositories)).not.toContain("octo/secret");
    expect(bed.fake.state.callsTo("GIT fetch").some((call) => call.path.includes("octo/secret"))).toBe(false);
    // The owner's own token does reach it: the same call is theirs.
    const theirs = await owner.call("projects.createFromGithub", {
      repository: "octo/secret" as never,
      mode: "clone",
    });
    expect(theirs.ok, JSON.stringify(theirs)).toBe(true);
  }, 240_000);
});
