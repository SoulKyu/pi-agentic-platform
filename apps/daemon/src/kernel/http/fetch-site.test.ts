import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../logger.ts";
import { createHttpApp } from "./app.ts";
import { fetchSiteRefused } from "./fetch-site.ts";

const ORIGIN = "http://localhost:7777";
const PREVIEW = "http://localhost:7778";
const HOOK = "/hooks/0a1b2c3d-4e5f-4a6b-8c7d-0123456789ab";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-fetch-site-"));
  mkdirSync(join(root, "web"));
  writeFileSync(join(root, "web", "index.html"), "<!doctype html><title>pap</title>");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface Seen {
  fetchSite: Array<[string, string]>;
  origin: Array<[string, string | undefined]>;
  hits: string[];
}
function build(frameSrc?: string | null) {
  const seen: Seen = { fetchSite: [], origin: [], hits: [] };
  const hit = (name: string) => (c: { json: (body: unknown) => Response }) => {
    seen.hits.push(name);
    return c.json({ ok: true });
  };
  const app = createHttpApp({
    allowedOrigins: new Set([ORIGIN]),
    staticRoot: join(root, "web"),
    logger: silentLogger,
    onFetchSiteRefused: (via, site) => seen.fetchSite.push([via, site]),
    onOriginRefused: (via, origin) => seen.origin.push([via, origin]),
    ...(frameSrc === undefined ? {} : { frameSrc }),
    mount: (a) => {
      a.get("/files/raw", hit("files"));
      a.get("/github/app/new", hit("github-new"));
      a.get("/github/app/created", hit("created"));
      a.get("/github/app/authorized", hit("authorized"));
      a.post("/auth/echo", hit("auth"));
      a.post("/form", hit("form"));
      a.post(HOOK, hit("hook"));
      a.get(HOOK, hit("hook-get"));
      a.post("/hooks/not-a-trigger", hit("bad-hook"));
    },
    wsProbe: (c) => c.json({ protocol: 1 }),
  });
  return { app, seen };
}
const send = (
  app: ReturnType<typeof build>["app"],
  path: string,
  headers: Record<string, string>,
  method = "GET",
) => app.request(path, { method, headers });

describe("the Sec-Fetch-Site guard", () => {
  it("refuses a same-site, cross-site or Same-Site read of a route, logged once each", async () => {
    const { app, seen } = build();
    for (const site of ["same-site", "cross-site", "Same-Site"]) {
      const response = await send(app, "/files/raw", { "sec-fetch-site": site });
      expect(response.status, site).toBe(403);
      expect(await response.json()).toEqual({ error: { code: "forbidden" } });
    }
    expect(seen.hits).toEqual([]);
    expect(seen.fetchSite).toEqual([
      ["http", "same-site"],
      ["http", "cross-site"],
      ["http", "Same-Site"],
    ]);
  });

  it("refuses a same-site POST before the Origin guard would", async () => {
    const { app, seen } = build();
    const response = await send(
      app,
      "/auth/echo",
      { "sec-fetch-site": "same-site", origin: "http://evil.test" },
      "POST",
    );
    expect(response.status).toBe(403);
    expect(seen.fetchSite).toEqual([["http", "same-site"]]);
    expect(seen.origin).toEqual([]);
    expect(seen.hits).toEqual([]);
  });

  it("lets same-origin, none and a request without the header through", async () => {
    const { app, seen } = build();
    const passing: Array<Record<string, string>> = [
      { "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "none" },
      {},
    ];
    for (const headers of passing) {
      expect((await send(app, "/files/raw", headers)).status, JSON.stringify(headers)).toBe(200);
    }
    expect(seen.fetchSite).toEqual([]);
  });

  it("lets a cross-site top-level navigation open the app shell, and nothing else of the app", async () => {
    const { app, seen } = build();
    const nav = {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    };
    expect((await send(app, "/", nav)).status).toBe(200);
    expect((await send(app, "/settings", nav)).status).toBe(200);
    expect(
      (await send(app, "/", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" })).status,
    ).toBe(200);
    expect((await send(app, "/", nav, "HEAD")).status).toBe(200);
    expect(seen.fetchSite).toEqual([]);
    for (const [path, headers, method] of [
      ["/files/raw", nav, "GET"],
      ["/github/app/new", nav, "GET"],
      ["/", { ...nav, "sec-fetch-dest": "iframe" }, "GET"],
      ["/", { ...nav, "sec-fetch-dest": "script", "sec-fetch-mode": "no-cors" }, "GET"],
      ["/", { ...nav, "sec-fetch-mode": "cors" }, "GET"],
      ["/", nav, "POST"],
    ] as const) {
      expect(
        (await send(app, path, headers, method)).status,
        `${method} ${path} ${JSON.stringify(headers)}`,
      ).toBe(403);
    }
    // A navigation by POST with an allowed Origin: only the Fetch Metadata rule can refuse it.
    expect((await send(app, "/form", { ...nav, origin: ORIGIN }, "POST")).status).toBe(403);
    expect(seen.hits).toEqual([]);
  });

  it("keeps the webhook reachable cross-site, and the two GitHub callbacks as cross-site document navigations only", async () => {
    const { app } = build();
    const cross = { "sec-fetch-site": "cross-site" };
    const nav = { ...cross, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    expect((await send(app, HOOK, cross, "POST")).status).toBe(200);
    expect((await send(app, "/github/app/created", nav)).status).toBe(200);
    expect((await send(app, "/github/app/authorized", nav)).status).toBe(200);
    // Not a cross-site document navigation: a fetch, an embed, a same-site page, a navigation by POST.
    expect((await send(app, "/github/app/created", cross)).status).toBe(403);
    expect((await send(app, "/github/app/created", { ...nav, "sec-fetch-dest": "iframe" })).status).toBe(403);
    expect((await send(app, "/github/app/created", { ...nav, "sec-fetch-mode": "cors" })).status).toBe(403);
    expect((await send(app, "/github/app/created", { ...nav, "sec-fetch-site": "same-site" })).status).toBe(
      403,
    );
    expect((await send(app, "/github/app/created", { ...nav, origin: ORIGIN }, "POST")).status).toBe(403);
    expect((await send(app, HOOK, cross)).status).toBe(403);
    expect((await send(app, "/hooks/not-a-trigger", cross, "POST")).status).toBe(403);
    expect((await send(app, "/github/app/new", nav)).status).toBe(403);
  });

  it("passes same-origin and none, and refuses any other value, known or not", async () => {
    const { app, seen } = build();
    for (const site of ["same-origin", "none", "SAME-ORIGIN"])
      expect((await send(app, "/files/raw", { "sec-fetch-site": site })).status, site).toBe(200);
    for (const site of ["same-site", "cross-site", "future-value", "", "same-origin, cross-site"])
      expect((await send(app, "/files/raw", { "sec-fetch-site": site })).status, site).toBe(403);
    expect(seen.fetchSite.length).toBe(5);
  });

  it("decides on the decoded reserved path", () => {
    const nav = { method: "GET", site: "cross-site", mode: "navigate", dest: "document" } as const;
    expect(fetchSiteRefused({ ...nav, path: "/%66iles/raw" })).toBe(true);
    expect(fetchSiteRefused({ ...nav, path: "/%2566iles" })).toBe(false);
    expect(fetchSiteRefused({ ...nav, path: "/%e0%a4%a" })).toBe(false);
    expect(fetchSiteRefused({ ...nav, path: "/ws" })).toBe(true);
    expect(fetchSiteRefused({ ...nav, path: "/files" })).toBe(true);
    expect(fetchSiteRefused({ ...nav, path: "/filesystem" })).toBe(false);
  });

  it("the app's frame-src names the preview origin and nothing else, and is absent without a listener", async () => {
    const without = (await build().app.request("/healthz")).headers.get("content-security-policy") ?? "";
    const withNull = (await build(null).app.request("/healthz")).headers.get("content-security-policy");
    const withOrigin =
      (await build(PREVIEW).app.request("/healthz")).headers.get("content-security-policy") ?? "";
    expect(without).not.toContain("frame-src");
    expect(withNull).toBe(without);
    expect(withOrigin).toContain(`frame-src ${PREVIEW}`);
    expect(withOrigin.replace(`; frame-src ${PREVIEW}`, "")).toBe(without);
    expect(withOrigin.match(/frame-src [^;]*/g)).toEqual([`frame-src ${PREVIEW}`]);
  });

  it("a frame-src that is not an exact origin fails closed: no frame-src at all", async () => {
    const without = (await build().app.request("/healthz")).headers.get("content-security-policy");
    for (const bad of [
      `${PREVIEW}/`,
      `${PREVIEW}/x`,
      `${PREVIEW} https://evil.test`,
      "*",
      "https://*.test",
      "not a url",
      "",
      "https://x.test:443",
    ]) {
      const csp = (await build(bad).app.request("/healthz")).headers.get("content-security-policy");
      expect(csp, bad).toBe(without);
    }
  });
});
