import type { RepoFullName } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCESS_TTL_MS, STALE_MAX_MS } from "./access.ts";
import { type GithubBed, startGithubBed } from "./testing/bed.ts";
import { connectUser } from "./testing/members.ts";

let bed: GithubBed;
let member: string;
beforeEach(async () => {
  bed = await startGithubBed();
  member = await connectUser(bed.fake, bed.core.userTokens, "member-1", "member");
  bed.fake.state.addRepo("octo/secret", { private: true });
});
afterEach(() => bed.close());

const reads = () => bed.fake.state.calls.filter((call) => call.route === "GET /repos/:o/:r").length;
const check = (repo: RepoFullName = "octo/secret", options?: { fresh?: boolean }) =>
  bed.core.access.check("member-1", repo, options);

describe("github access", () => {
  it("accepts a token with push, refuses pull-only and an invisible repository the same way", async () => {
    bed.fake.state.access.restrict("octo/secret", { [member]: "push" });
    await expect(check()).resolves.toBeUndefined();
    bed.fake.state.access.restrict("octo/secret", { [member]: "pull" });
    await expect(check("octo/secret", { fresh: true })).rejects.toMatchObject({ code: "not_found" });
    bed.fake.state.access.restrict("octo/secret", {});
    await expect(check("octo/secret", { fresh: true })).rejects.toMatchObject({ code: "not_found" });
    await expect(check("octo/missing", { fresh: true })).rejects.toMatchObject({ code: "not_found" });
  });

  it("a user with no GitHub connection has no access", async () => {
    await expect(bed.core.access.check("stranger", "octo/secret")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("the answer is cached for 10 minutes per owner and repository", async () => {
    await check();
    await check();
    expect(reads()).toBe(1);
    bed.fake.state.addRepo("octo/other");
    await check("octo/other");
    expect(reads()).toBe(2);
    await bed.clock.advance(ACCESS_TTL_MS - 1);
    await check();
    expect(reads()).toBe(2);
    await bed.clock.advance(1);
    await check();
    expect(reads()).toBe(3);
    await check("octo/secret", { fresh: true });
    expect(reads()).toBe(4);
  });

  it("the cache is per owner: one owner's allowed decision never answers for another", async () => {
    bed.fake.state.access.restrict("octo/secret", { [member]: "push" });
    await check();
    const other = await connectUser(bed.fake, bed.core.userTokens, "member-2", "member-2");
    expect(other).not.toBe(member);
    await expect(bed.core.access.check("member-2", "octo/secret")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(reads()).toBe(2);
    await expect(check()).resolves.toBeUndefined();
    expect(reads()).toBe(2);
  });

  it("a reconnect-needed token is a lost access, not an outage", async () => {
    await check();
    bed.fake.state.respond("POST /login/oauth/access_token", {
      status: 200,
      body: { error: "bad_refresh_token" },
    });
    await bed.clock.advance(8 * 3_600_000);
    // The token expired and its refresh is refused: that check flags the reconnect, the next one knows.
    await expect(check()).rejects.toMatchObject({ code: "github_unavailable" });
    expect(bed.core.userTokens.state("member-1")).toBe("reconnect");
    await expect(check()).rejects.toMatchObject({ code: "not_found" });
  });

  it("a 401 on the user token (authorization revoked) is a lost access, even with an earlier allowed decision", async () => {
    await check();
    await bed.clock.advance(ACCESS_TTL_MS);
    bed.fake.state.fail("GET /repos/:o/:r", 401, "Bad credentials", 1);
    await expect(check()).rejects.toMatchObject({ code: "not_found" });
  });

  it("a rate-limited check keeps the cached decision, then asks again", async () => {
    await check();
    bed.fake.state.access.restrict("octo/secret", {});
    await bed.clock.advance(ACCESS_TTL_MS);
    bed.fake.state.fail("GET /repos/:o/:r", 429, "slow down", 2);
    await expect(check()).resolves.toBeUndefined();
    await expect(check()).resolves.toBeUndefined();
    // The limit is over: the verdict is the real one.
    await expect(check()).rejects.toMatchObject({ code: "not_found" });
  });

  it("a kept decision holds for an hour from its last successful check, then the check is refused", async () => {
    await check();
    bed.fake.state.fail("GET /repos/:o/:r", 429, "slow down");
    await bed.clock.advance(STALE_MAX_MS - 1);
    await expect(check()).resolves.toBeUndefined();
    await bed.clock.advance(1);
    await expect(check()).rejects.toMatchObject({ code: "capacity" });
  });

  it("an outage without an earlier decision, or on a fresh call, is not a verdict", async () => {
    bed.fake.state.fail("GET /repos/:o/:r", 500, "down", 1);
    await expect(check()).rejects.toMatchObject({ code: "github_unavailable" });
    await check();
    bed.fake.state.fail("GET /repos/:o/:r", 429, "slow down", 1);
    await expect(check("octo/secret", { fresh: true })).rejects.toMatchObject({ code: "capacity" });
  });
});
