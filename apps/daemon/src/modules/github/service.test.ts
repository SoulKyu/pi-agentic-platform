import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { OWNER } from "./testing/bed.ts";
import { type FeatureBed, PAP_ORIGIN, SECOND_ORIGIN, startFeatureBed } from "./testing/feature.ts";

let bed: FeatureBed;
afterEach(() => bed.close());

async function connect(): Promise<void> {
  const response = await fetch(`${bed.fake.origin}/login/oauth/access_token`, {
    method: "POST",
    body: JSON.stringify({ code: "c1" }),
  });
  bed.core.userTokens.store(
    OWNER,
    (await response.json()) as Parameters<typeof bed.core.userTokens.store>[1],
  );
}
const status = (origin: string | undefined = PAP_ORIGIN) => bed.feature.service.status(bed.caller, origin);

describe("status", () => {
  beforeEach(async () => {
    bed = await startFeatureBed({ withApp: true });
  });

  it("reports absent, created, connected, reconnect and the origin mismatch", async () => {
    bed.core.appSecrets.forget();
    expect(await status()).toEqual({ state: "absent", app: null, login: null, permissionMissing: false });

    bed.core.appSecrets.save(bed.app);
    const created = await status();
    expect(created.state).toBe("created");
    expect(created.app).toEqual({
      slug: "pap-fake",
      htmlUrl: bed.app.htmlUrl,
      callbackOrigin: PAP_ORIGIN,
      originMatches: true,
    });
    expect(JSON.stringify(created)).not.toContain(bed.app.clientSecret);

    await connect();
    const connected = await status();
    expect(connected).toMatchObject({ state: "connected", login: "octo", permissionMissing: false });
    bed.feature.service.setPermissionMissing(true);
    expect((await status()).permissionMissing).toBe(true);
    expect((await status("http://other.test")).app?.originMatches).toBe(false);
    expect((await status(undefined)).app?.originMatches).toBe(true);

    await bed.clock.advance(15_811_200_000 + 1);
    expect(await status()).toMatchObject({ state: "reconnect", login: null, permissionMissing: false });
  });

  it("a token may read the status and nothing else", async () => {
    const token = testCaller({ kind: "token", userId: OWNER });
    const { service } = bed.feature;
    expect((await service.status(token, undefined)).state).toBe("created");
    const refused = [
      () => service.startCreate(token, PAP_ORIGIN),
      () => service.authorizeUrl(token, undefined),
      () => service.disconnect(token),
      () => service.forget(token),
    ];
    for (const call of refused) expect(call).toThrow(expect.objectContaining({ code: "forbidden" }));
  });

  it("disconnect drops the user pair and keeps the App", async () => {
    await connect();
    bed.feature.service.disconnect(bed.caller);
    expect(bed.core.userTokens.state(OWNER)).toBe("none");
    expect(bed.core.appSecrets.load()).not.toBeNull();
    expect(bed.audit.map((row) => row.reason)).toContain("github_disconnected");
  });

  it("forget needs the step-up and clears every secret", async () => {
    await connect();
    expect(() => bed.feature.service.forget(bed.caller)).toThrow(PapError);
    expect(() => bed.feature.service.forget(bed.caller)).toThrow(
      expect.objectContaining({ code: "step_up_required" }),
    );
    expect(bed.core.appSecrets.load()).not.toBeNull();
    expect(bed.core.userTokens.state(OWNER)).toBe("ok");

    bed.feature.service.forget({ ...bed.caller, stepUpUntil: bed.clock.now() + 1000 });
    expect(bed.core.appSecrets.load()).toBeNull();
    expect(bed.core.userTokens.state(OWNER)).toBe("none");
    expect(await status()).toMatchObject({ state: "absent", login: null });
    expect(bed.audit.map((row) => row.reason)).toContain("github_forgotten");
  });
});

describe("startCreate and authorizeUrl", () => {
  it("startCreate answers the page URL with a state, and refuses when an App exists", async () => {
    bed = await startFeatureBed();
    const started = bed.feature.service.startCreate(bed.caller, PAP_ORIGIN);
    expect(started.postUrl).toBe(`${PAP_ORIGIN}/github/app/new?state=${started.state}`);
    expect(JSON.parse(started.manifest).redirect_url).toBe(`${PAP_ORIGIN}/github/app/created`);
    expect(() => bed.feature.service.authorizeUrl(bed.caller, undefined)).toThrow(
      expect.objectContaining({ code: "github_unavailable" }),
    );
    bed.core.appSecrets.save(bed.app);
    expect(() => bed.feature.service.startCreate(bed.caller, PAP_ORIGIN)).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
  });

  it("authorizeUrl builds GitHub's sign-in URL on the recorded callback", async () => {
    bed = await startFeatureBed({ withApp: true });
    const url = new URL(bed.feature.service.authorizeUrl(bed.caller, undefined));
    expect(url.origin + url.pathname).toBe(`${bed.fake.origin}/login/oauth/authorize`);
    expect(url.searchParams.get("redirect_uri")).toBe(`${PAP_ORIGIN}/github/app/authorized`);
  });

  it("authorizeUrl from a second allowed origin returns there, an origin that is not allowed is refused", async () => {
    bed = await startFeatureBed({ withApp: true });
    const url = new URL(bed.feature.service.authorizeUrl(bed.caller, SECOND_ORIGIN));
    expect(url.searchParams.get("redirect_uri")).toBe(`${SECOND_ORIGIN}/github/app/authorized`);
    expect(() => bed.feature.service.authorizeUrl(bed.caller, "http://evil.test")).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
  });

  it("a sign-in from a second origin exchanges the code on that origin, comes back there, and clears the mismatch notice", async () => {
    bed = await startFeatureBed({ withApp: true });
    expect((await status(SECOND_ORIGIN)).app?.originMatches).toBe(false);
    const url = new URL(bed.feature.service.authorizeUrl(bed.caller, SECOND_ORIGIN));
    const outcome = await bed.feature.service.completeAuthorize(
      "code-9",
      url.searchParams.get("state") ?? "",
    );
    expect(outcome).toEqual({ kind: "authorized", home: `${SECOND_ORIGIN}/` });
    const exchange = bed.fake.state.callsTo("POST /login/oauth/access_token").at(-1);
    expect(exchange?.body).toMatchObject({
      code: "code-9",
      redirect_uri: `${SECOND_ORIGIN}/github/app/authorized`,
    });
    expect((await status(SECOND_ORIGIN)).app?.originMatches).toBe(true);
    expect((await status("http://other.test")).app?.originMatches).toBe(false);
    expect(bed.core.appSecrets.load()?.callbackOrigin).toBe(PAP_ORIGIN);
  });

  it("a sign-in whose callback GitHub refuses proves nothing", async () => {
    bed = await startFeatureBed({ withApp: true });
    const url = new URL(bed.feature.service.authorizeUrl(bed.caller, SECOND_ORIGIN));
    bed.fake.state.respond("POST /login/oauth/access_token", {
      status: 200,
      body: { error: "redirect_uri_mismatch" },
    });
    const outcome = await bed.feature.service.completeAuthorize(
      "code-9",
      url.searchParams.get("state") ?? "",
    );
    expect(outcome.kind).toBe("github");
    expect((await status(SECOND_ORIGIN)).app?.originMatches).toBe(false);
  });

  it("the permissions link goes to the App's settings, not its public page", async () => {
    bed = await startFeatureBed();
    const created = bed.core.states.issue(bed.caller.userId, "created", PAP_ORIGIN);
    const outcome = await bed.feature.service.completeCreate("manifest-code", created);
    expect(outcome).toMatchObject({
      kind: "created",
      permissionsUrl: `${bed.fake.origin}/settings/apps/pap-fake/permissions`,
      installationsUrl: `${bed.fake.origin}/settings/installations`,
    });
  });
});
