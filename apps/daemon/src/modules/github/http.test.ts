import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STATE_TTL_MS } from "./states.ts";
import { COOKIE, type FeatureBed, PAP_ORIGIN, startFeatureBed } from "./testing/feature.ts";

let bed: FeatureBed;
beforeEach(async () => {
  bed = await startFeatureBed();
});
afterEach(() => bed.close());

const get = (path: string, cookie?: string) =>
  bed.app_.request(`${PAP_ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
const decode = (text: string): string =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const stateOf = (url: string): string => new URL(url).searchParams.get("state") ?? "";

/** The owner starts the flow and the browser loads the manifest page. */
async function openManifestPage() {
  const { state } = bed.feature.service.startCreate(bed.caller, PAP_ORIGIN);
  const response = await get(`/github/app/new?state=${state}`, COOKIE);
  const html = await response.text();
  return { state, response, html };
}
async function createdState(): Promise<string> {
  const { html } = await openManifestPage();
  return stateOf(decode(/action="([^"]+)"/.exec(html)?.[1] ?? ""));
}
const nothingStored = (): void => {
  expect(bed.core.appSecrets.load()).toBeNull();
  expect(bed.fake.state.callsTo("POST /app-manifests")).toHaveLength(0);
};

describe("GET /github/app/new", () => {
  it("the manifest page posts the exact manifest with a state", async () => {
    const { state, response, html } = await openManifestPage();
    expect(response.status).toBe(200);
    const action = decode(/action="([^"]+)"/.exec(html)?.[1] ?? "");
    const manifest = decode(/name="manifest" value="([^"]*)"/.exec(html)?.[1] ?? "");
    const url = new URL(action);
    expect(url.origin + url.pathname).toBe(`${bed.fake.origin}/settings/apps/new`);
    expect(stateOf(action)).toMatch(/^[0-9a-f]{32}$/);
    expect(stateOf(action)).not.toBe(state); // the start state is spent, GitHub gets a fresh one
    expect(JSON.parse(manifest)).toEqual({
      name: expect.stringMatching(/^pap-my-host-[0-9a-f]{4}$/),
      url: PAP_ORIGIN,
      hook_attributes: { url: PAP_ORIGIN, active: false },
      redirect_url: `${PAP_ORIGIN}/github/app/created`,
      callback_urls: [`${PAP_ORIGIN}/github/app/authorized`],
      request_oauth_on_install: true,
      public: false,
      default_permissions: {
        contents: "write",
        pull_requests: "write",
        issues: "read",
        checks: "read",
        actions: "read",
        metadata: "read",
        administration: "write",
      },
    });
    expect(response.headers.get("content-security-policy")).toContain(`form-action ${bed.fake.origin}`);
    // What the browser posts reaches GitHub as is.
    await fetch(action, { method: "POST", body: new URLSearchParams({ manifest }) });
    expect(bed.fake.state.manifests).toEqual([manifest]);
  });

  it("needs the session cookie and a live state, once", async () => {
    const { state } = bed.feature.service.startCreate(bed.caller, PAP_ORIGIN);
    expect((await get(`/github/app/new?state=${state}`)).status).toBe(401);
    expect((await get(`/github/app/new?state=${state}`, COOKIE)).status).toBe(200);
    expect((await get(`/github/app/new?state=${state}`, COOKIE)).status).toBe(400); // spent
    expect((await get("/github/app/new", COOKIE)).status).toBe(400);
    expect((await get("/github/app/new?state=zz", COOKIE)).status).toBe(400);
  });

  it("escapes what it puts in the page", async () => {
    const { html } = await openManifestPage();
    expect(html).not.toContain('{"name"'); // quotes in the manifest are entities, so the attribute cannot end early
    expect(html).toContain("&quot;name&quot;");
  });
});

describe("GET /github/app/created", () => {
  it("a reused, expired or foreign state is refused and stores nothing", async () => {
    const stale = await createdState();
    const wrongPurpose = bed.core.states.issue("owner-1", "authorize");
    await bed.clock.advance(STATE_TTL_MS);
    const fresh = await createdState();
    const spent = await createdState();
    expect(bed.core.states.take(spent, "created")).not.toBeNull();
    for (const state of [stale, spent, wrongPurpose, "0".repeat(32), "bad"]) {
      const response = await get(`/github/app/created?code=abc&state=${state}`);
      expect(response.status, state).toBe(400);
      nothingStored();
    }
    expect((await get(`/github/app/created?code=abc`)).status).toBe(400);
    expect((await get(`/github/app/created?state=${fresh}`)).status).toBe(400);
  });

  it("a valid one stores the App and its origin, with no cookie", async () => {
    const state = await createdState();
    const response = await get(`/github/app/created?code=abc123&state=${state}`);
    expect(response.status).toBe(200);
    const stored = bed.core.appSecrets.load();
    expect(stored?.slug).toBe("pap-fake");
    expect(stored?.callbackOrigin).toBe(PAP_ORIGIN);
    expect(bed.fake.state.callsTo("POST /app-manifests")).toHaveLength(1);
    const html = await response.text();
    expect(html).toContain("pap-fake");
    expect(html).toContain(`${bed.fake.origin}/settings/apps/${stored?.slug}/permissions`);
    expect(html).toMatch(/installations\/new\?state=[0-9a-f]{32}/);
    expect(html).toContain(`href="${PAP_ORIGIN}/"`);
    expect(html).not.toContain(stored?.clientSecret ?? "?");
    expect(response.headers.get("content-security-policy")).toContain("form-action 'none'");
    expect(bed.audit.map((row) => row.reason)).toContain("github_app_created");
    // Replay: refused, and the App is not replaced.
    expect((await get(`/github/app/created?code=abc123&state=${state}`)).status).toBe(400);
    expect(bed.fake.state.callsTo("POST /app-manifests")).toHaveLength(1);
  });

  it("does not replace an App that exists", async () => {
    const state = await createdState();
    bed.core.appSecrets.save(bed.app);
    expect((await get(`/github/app/created?code=abc&state=${state}`)).status).toBe(400);
    expect(bed.fake.state.callsTo("POST /app-manifests")).toHaveLength(0);
  });
});

describe("the install link and GET /github/app/authorized", () => {
  async function created(): Promise<string> {
    const response = await get(`/github/app/created?code=abc&state=${await createdState()}`);
    const html = await response.text();
    return /installations\/new\?state=([0-9a-f]{32})/.exec(html)?.[1] ?? "";
  }

  it("stores the user pair, with no cookie, once", async () => {
    const state = await created();
    const response = await get(`/github/app/authorized?code=c1&installation_id=7&state=${state}`);
    expect(response.status).toBe(200);
    expect(bed.core.userTokens.state("owner-1")).toBe("ok");
    expect(await bed.core.userTokens.get("owner-1")).toBe(bed.fake.state.userTokens.access);
    expect(bed.audit.map((row) => row.reason)).toContain("github_authorized");
    expect(await response.text()).not.toContain(bed.fake.state.userTokens.access);
    const replay = await get(`/github/app/authorized?code=c2&installation_id=7&state=${state}`);
    expect(replay.status).toBe(400);
    expect(bed.fake.state.callsTo("POST /login/oauth/access_token")).toHaveLength(1);
  });

  it("refuses an expired, foreign or wrong-purpose state and stores nothing", async () => {
    const stale = await created();
    await bed.clock.advance(STATE_TTL_MS);
    const wrongPurpose = bed.core.states.issue("owner-1", "created", PAP_ORIGIN);
    for (const state of [stale, wrongPurpose, "1".repeat(32)]) {
      expect((await get(`/github/app/authorized?code=c1&state=${state}`)).status, state).toBe(400);
    }
    expect(bed.core.userTokens.state("owner-1")).toBe("none");
    expect(bed.fake.state.callsTo("POST /login/oauth/access_token")).toHaveLength(0);
  });

  it("answers a bad code from GitHub with nothing stored", async () => {
    await created();
    const state = bed.core.states.issue("owner-1", "authorize");
    bed.fake.state.respond("POST /login/oauth/access_token", {
      status: 200,
      body: { error: "bad_verification_code" },
    });
    expect((await get(`/github/app/authorized?code=c1&state=${state}`)).status).toBe(502);
    expect(bed.core.userTokens.state("owner-1")).toBe("none");
  });

  it("GET /github/app/authorize redirects a signed-in owner to GitHub with a fresh state", async () => {
    await created();
    expect((await get("/github/app/authorize")).status).toBe(401);
    const response = await get("/github/app/authorize", COOKIE);
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("location") ?? "");
    expect(target.origin + target.pathname).toBe(`${bed.fake.origin}/login/oauth/authorize`);
    expect(target.searchParams.get("client_id")).toBe("Iv1.fake");
    expect(target.searchParams.get("redirect_uri")).toBe(`${PAP_ORIGIN}/github/app/authorized`);
    expect(target.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("keeps other /github paths out of the SPA", async () => {
    expect((await get("/github/other")).status).toBe(404);
    expect((await get("/github/app/new", "pap_session=bad")).status).toBe(401);
  });
});

describe("origin, concurrency and logging", () => {
  it("`new` registers the origin startCreate carried, whatever the Host header says", async () => {
    const { state } = bed.feature.service.startCreate(bed.caller, PAP_ORIGIN);
    const response = await bed.app_.request("http://evil.test/github/app/new?state=" + state, {
      headers: { cookie: COOKIE },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    const manifest = JSON.parse(decode(/name="manifest" value="([^"]*)"/.exec(html)?.[1] ?? ""));
    expect(manifest.redirect_url).toBe(`${PAP_ORIGIN}/github/app/created`);
    expect(html).not.toContain("evil.test");
    const created = stateOf(decode(/action="([^"]+)"/.exec(html)?.[1] ?? ""));
    await get(`/github/app/created?code=abc&state=${created}`);
    expect(bed.core.appSecrets.load()?.callbackOrigin).toBe(PAP_ORIGIN);
  });

  it("startCreate from an origin outside allowedOrigins is refused", () => {
    expect(() => bed.feature.service.startCreate(bed.caller, "http://evil.test")).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
  });

  it("error pages carry the page's own CSP too", async () => {
    const response = await get(`/github/app/created?code=abc&state=${"0".repeat(32)}`);
    expect(response.status).toBe(400);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain("unsafe-inline");
    bed.fake.state.fail("POST /app-manifests/:code/conversions", 500);
    const github = await get(`/github/app/created?code=abc&state=${await createdState()}`);
    expect(github.status).toBe(502);
    expect(github.headers.get("content-security-policy")).toContain("form-action 'none'");
    expect(
      bed.lines.some(
        (line) =>
          line.msg === "github_create_failed" || JSON.stringify(line).includes("github_create_failed"),
      ),
    ).toBe(true);
  });

  it("two concurrent valid states cannot overwrite the App", async () => {
    const first = await createdState();
    const second = await createdState();
    const [a, b] = await Promise.all([
      get(`/github/app/created?code=one&state=${first}`),
      get(`/github/app/created?code=two&state=${second}`),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect(bed.core.appSecrets.load()?.clientSecret).toBeTruthy();
  });

  it("forget drops the pending states", async () => {
    const pending = await createdState();
    bed.feature.service.forget({ ...bed.caller, stepUpUntil: bed.clock.now() + 1000 });
    expect((await get(`/github/app/created?code=abc&state=${pending}`)).status).toBe(400);
    nothingStored();
  });

  it("logs a failing request by path only, never the code or the state", async () => {
    const { createHttpApp } = await import("../../kernel/http/app.ts");
    const throwing = createHttpApp({
      allowedOrigins: new Set([PAP_ORIGIN]),
      staticRoot: null,
      logger: bed.logger,
      mount: (hono) =>
        hono.get("/github/app/created", () => {
          throw new Error("boom");
        }),
      wsProbe: (c) => c.json({}),
    });
    const state = "a".repeat(32);
    await throwing.request(`${PAP_ORIGIN}/github/app/created?code=SECRETCODE&state=${state}`);
    const logged = JSON.stringify(bed.lines);
    expect(logged).toContain("http_error");
    expect(logged).not.toContain("SECRETCODE");
    expect(logged).not.toContain(state);
  });
});
