import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PARKED_TTL_MS } from "./parked.ts";
import { STATE_TTL_MS } from "./states.ts";
import {
  COOKIE,
  type FeatureBed,
  MEMBER,
  MEMBER_COOKIE,
  PAP_ORIGIN,
  startFeatureBed,
} from "./testing/feature.ts";

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
      public: true,
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

  /** The ticket the callback page hands to the browser that hit it. */
  async function callback(state: string, code = "c1"): Promise<{ status: number; ticket: string }> {
    const response = await get(`/github/app/authorized?code=${code}&installation_id=7&state=${state}`);
    const html = await response.text();
    return { status: response.status, ticket: /finish\?ticket=([0-9a-f]{32})/.exec(html)?.[1] ?? "" };
  }
  const finish = (ticket: string, cookie?: string) =>
    get(`/github/app/authorized/finish?ticket=${ticket}`, cookie);

  it("the callback parks the pair under a ticket, the owner's own session binds it, once", async () => {
    const state = await created();
    const { status, ticket } = await callback(state);
    expect(status).toBe(200);
    expect(ticket).toMatch(/^[0-9a-f]{32}$/);
    expect(ticket).not.toBe(state);
    expect(bed.core.userTokens.state("owner-1")).toBe("none");
    const done = await finish(ticket, COOKIE);
    expect(done.status).toBe(200);
    expect(bed.core.userTokens.state("owner-1")).toBe("ok");
    expect(await bed.core.userTokens.get("owner-1")).toBe(bed.fake.state.userTokens.access);
    expect(bed.audit.map((row) => row.reason)).toContain("github_authorized");
    expect(await done.text()).not.toContain(bed.fake.state.userTokens.access);
    expect((await callback(state, "c2")).status).toBe(400);
    expect((await finish(ticket, COOKIE)).status).toBe(400);
    expect(bed.fake.state.callsTo("POST /login/oauth/access_token")).toHaveLength(1);
  });

  it("the state alone finishes nothing", async () => {
    const state = await created();
    await callback(state);
    expect((await get(`/github/app/authorized/finish?state=${state}`, COOKIE)).status).toBe(400);
    expect((await finish(state, COOKIE)).status).toBe(400);
    expect(bed.core.userTokens.state("owner-1")).toBe("none");
  });

  it("a member's authorize link opened by the owner never stores the owner's token on the member", async () => {
    await created();
    const state = bed.core.states.issue(MEMBER, "authorize");
    // The owner's browser is the one GitHub sends back (the owner's code), and the owner's cookie is the one that comes.
    const { status, ticket } = await callback(state, "owner-code");
    expect(status).toBe(200);
    expect((await finish(ticket, COOKIE)).status).toBe(400);
    expect(bed.core.userTokens.state(MEMBER)).toBe("none");
    expect(bed.core.userTokens.state("owner-1")).toBe("none");
    const refused = bed.audit.filter((row) => row.reason === "github_link_refused");
    expect(refused.map((row) => row.ownerId).sort()).toEqual(["owner-1", MEMBER].sort());
    expect(JSON.stringify(refused)).not.toContain(bed.fake.state.userTokens.access);
    // The pair is gone: the member cannot finish it afterwards either.
    expect((await finish(ticket, MEMBER_COOKIE)).status).toBe(400);
    expect(bed.core.userTokens.state(MEMBER)).toBe("none");
  });

  it("the member who started the sign-in cannot finish with the state while the owner's token is parked", async () => {
    await created();
    const state = bed.core.states.issue(MEMBER, "authorize");
    // The member polls with their own cookie, by state, before and after the owner's callback.
    const poll = () => get(`/github/app/authorized/finish?state=${state}`, MEMBER_COOKIE);
    expect((await poll()).status).toBe(400);
    const { ticket } = await callback(state, "owner-code");
    expect((await poll()).status).toBe(400);
    expect((await finish(state, MEMBER_COOKIE)).status).toBe(400);
    expect(bed.core.userTokens.state(MEMBER)).toBe("none");
    // The owner clicks Continue: refused, the ticket is spent, nothing is stored on the member.
    expect((await finish(ticket, COOKIE)).status).toBe(400);
    expect(bed.core.userTokens.state(MEMBER)).toBe("none");
    expect(bed.core.userTokens.state("owner-1")).toBe("none");
  });

  it("a finish without a session cookie keeps the ticket", async () => {
    const state = await created();
    const { ticket } = await callback(state);
    const again = await finish(ticket);
    expect(again.status).toBe(200);
    const html = await again.text();
    expect(html).toContain(`finish?ticket=${ticket}`);
    expect(html).not.toContain("http-equiv"); // no automatic retry loop: the person clicks
    expect(bed.core.userTokens.state("owner-1")).toBe("none");
    expect(bed.audit.map((row) => row.reason)).not.toContain("github_link_refused");
    expect((await finish(ticket, COOKIE)).status).toBe(200);
    expect(bed.core.userTokens.state("owner-1")).toBe("ok");
  });

  it("a parked pair expires after five minutes", async () => {
    const state = await created();
    const { ticket } = await callback(state);
    await bed.clock.advance(PARKED_TTL_MS);
    expect((await finish(ticket, COOKIE)).status).toBe(400);
    expect((await finish(ticket)).status).toBe(400);
    expect(bed.core.userTokens.state("owner-1")).toBe("none");
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

  it("GET /github/app/authorize is gone: a sign-in starts from github.authorizeUrl only (decision 139)", async () => {
    await created();
    expect((await get("/github/app/authorize", COOKIE)).status).toBe(404);
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
