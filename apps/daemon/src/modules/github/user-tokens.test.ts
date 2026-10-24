import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVaultStore } from "../secrets/index.ts";
import { type GithubBed, OWNER, startGithubBed } from "./testing/bed.ts";
import { REFRESH_TOKEN, USER_TOKEN } from "./user-tokens.ts";

let bed: GithubBed;
let first = { access: "", refresh: "" };
beforeEach(async () => {
  bed = await startGithubBed();
  // The OAuth exchange of the first sign-in, as the fake answers it.
  const response = await fetch(`${bed.fake.origin}/login/oauth/access_token`, {
    method: "POST",
    body: JSON.stringify({ code: "first" }),
  });
  const pair = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    refresh_token_expires_in: number;
  };
  first = { access: pair.access_token, refresh: pair.refresh_token };
  bed.core.userTokens.store(OWNER, pair);
  bed.fake.state.calls.length = 0;
});
afterEach(() => bed.close());

describe("user tokens", () => {
  it("returns the stored token while it is fresh", async () => {
    expect(await bed.core.userTokens.get(OWNER)).toBe(first.access);
    expect(bed.fake.state.calls).toHaveLength(0);
  });

  it("two concurrent refreshes call GitHub once", async () => {
    await bed.clock.advance(28_800_000);
    const [a, b] = await Promise.all([bed.core.userTokens.get(OWNER), bed.core.userTokens.get(OWNER)]);
    expect(a).toBe(b);
    expect(a).not.toBe(first.access);
    expect(bed.fake.state.userTokens.refreshes).toBe(1);
    expect(bed.fake.state.callsTo("POST /login/oauth/access_token")).toHaveLength(1);
  });

  it("the new pair is stored before use", async () => {
    await bed.clock.advance(28_800_000);
    const token = await bed.core.userTokens.get(OWNER);
    // A second vault reader, as after a restart: the refreshed pair is already there.
    const stored = createVaultStore(join(bed.home, "secrets", "vault")).reveal(OWNER, { kind: "user" });
    expect(stored[USER_TOKEN]).toBe(token);
    expect(stored[REFRESH_TOKEN]).toBe(bed.fake.state.userTokens.refresh);
    expect(await bed.core.userTokens.get(OWNER)).toBe(token);
    expect(bed.fake.state.userTokens.refreshes).toBe(1);
  });

  it("an expired refresh token sets reconnect", async () => {
    await bed.clock.advance(15_811_200_000 + 1000);
    await expect(bed.core.userTokens.get(OWNER)).rejects.toMatchObject({ code: "github_unavailable" });
    expect(bed.core.userTokens.state(OWNER)).toBe("reconnect");
    expect(bed.fake.state.calls).toHaveLength(0);
  });

  it("a refresh GitHub refuses sets reconnect, and later calls do not retry", async () => {
    bed.fake.state.userTokens.refresh = "ghr_other";
    await bed.clock.advance(28_800_000);
    await expect(bed.core.userTokens.get(OWNER)).rejects.toMatchObject({ code: "github_unavailable" });
    expect(bed.core.userTokens.state(OWNER)).toBe("reconnect");
    await expect(bed.core.userTokens.get(OWNER)).rejects.toMatchObject({ code: "github_unavailable" });
    expect(bed.fake.state.callsTo("POST /login/oauth/access_token")).toHaveLength(1);
  });

  it("a network failure keeps the pair and does not ask for a reconnect", async () => {
    bed.fake.state.fail("POST /login/oauth/access_token", 500, "boom", 1);
    await bed.clock.advance(28_800_000);
    await expect(bed.core.userTokens.get(OWNER)).rejects.toMatchObject({ code: "github_unavailable" });
    expect(bed.core.userTokens.state(OWNER)).toBe("ok");
    expect(await bed.core.userTokens.get(OWNER)).not.toBe(first.access);
  });

  it("has no token before sign-in and after clear", () => {
    bed.core.userTokens.clear(OWNER);
    expect(bed.core.userTokens.state(OWNER)).toBe("none");
    return expect(bed.core.userTokens.get(OWNER)).rejects.toMatchObject({ code: "github_unavailable" });
  });
});
