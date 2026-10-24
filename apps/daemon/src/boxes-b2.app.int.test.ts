import { afterEach, describe, expect, it } from "vitest";
import { startGithubBoxBed, type GithubBoxBed } from "./testing/github-bed.ts";
import { httpRequest } from "./testing/http-client.ts";

// Journey of boxes lot B2, the GitHub App: the manifest flow and the authorization against the fake GitHub, the way the
// browser walks them (the cross-site callbacks carry no cookie, the single-use state alone).

let bed: GithubBoxBed | undefined;
afterEach(async () => {
  await bed?.stop();
  bed = undefined;
});

describe("the GitHub App", () => {
  it("create the App, authorize, the status is connected", async () => {
    bed = await startGithubBoxBed();
    const { status: before } = await bed.ask("github.status", {});
    expect(before).toMatchObject({ state: "absent", app: null });

    await bed.connectApp();

    const { status } = await bed.ask("github.status", {});
    expect(status).toMatchObject({
      state: "connected",
      login: "octo",
      permissionMissing: false,
      app: { slug: "pap-fake" },
    });
    // The manifest GitHub received: private, no webhook, the callbacks on the address pap was reached at.
    const manifest = JSON.parse(bed.fake.state.manifests[0] ?? "{}") as Record<string, unknown>;
    expect(manifest).toMatchObject({
      public: false,
      hook_attributes: { active: false },
      redirect_url: `${bed.t.origin}/github/app/created`,
      callback_urls: [`${bed.t.origin}/github/app/authorized`],
    });
    // The App file exists; nothing the status said carries the secrets.
    expect(JSON.stringify(status)).not.toContain(bed.pem.slice(30, 60));
  }, 120_000);

  it("a callback with a reused, foreign or missing state is refused and changes nothing", async () => {
    bed = await startGithubBoxBed();
    const start = await bed.ask("github.startCreate", {});
    const page = await httpRequest(
      `${bed.t.base}${new URL(start.postUrl).pathname}${new URL(start.postUrl).search}`,
      {
        headers: { cookie: bed.owner.cookie },
      },
    );
    const state = /settings\/apps\/new\?state=([0-9a-f]{32})/.exec(page.body)?.[1] ?? "";
    expect(state).toHaveLength(32);

    const get = (path: string) => httpRequest(`${bed?.t.base}${path}`);
    expect((await get(`/github/app/created?code=abc`)).status).toBe(400);
    expect((await get(`/github/app/created?code=abc&state=${"0".repeat(32)}`)).status).toBe(400);
    expect((await get(`/github/app/created?code=abc&state=${start.state}`)).status).toBe(400);
    expect((await get(`/github/app/authorized?code=abc&state=${state}`)).status).toBe(400);
    expect((await bed.ask("github.status", {})).status.state).toBe("absent");
    expect(bed.fake.state.callsTo("POST /app-manifests")).toHaveLength(0);

    expect((await get(`/github/app/created?code=abc&state=${state}`)).status).toBe(200);
    // Single use: the same state again is refused, and the App stays as it was made.
    expect((await get(`/github/app/created?code=abc&state=${state}`)).status).toBe(400);
    expect(bed.fake.state.callsTo("POST /app-manifests")).toHaveLength(1);
    expect((await bed.ask("github.status", {})).status.state).toBe("created");
  }, 120_000);
});
