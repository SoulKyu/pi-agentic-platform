import { describe, expect, it } from "vitest";
import { cacheable, routeOf } from "./sw.ts";
import { ORIGIN } from "./harness.ts";

const req = (path: string, mode = "cors", method = "GET") => ({
  method,
  mode,
  url: new URL(path, ORIGIN).href,
});

describe("route.table", () => {
  it("routes the SPA shell and navigations", () => {
    expect(routeOf(req("/", "navigate"), ORIGIN)).toBe("navigation");
    expect(routeOf(req("/n/abc", "navigate"), ORIGIN)).toBe("navigation");
    expect(routeOf(req("/assets/a.js"), ORIGIN)).toBe("shell");
    expect(routeOf(req("/icons/icon-192.png"), ORIGIN)).toBe("shell");
    expect(routeOf(req("/manifest.webmanifest"), ORIGIN)).toBe("shell");
  });

  it("passes everything that is not a same-origin GET of the SPA", () => {
    expect(routeOf(req("/", "navigate", "POST"), ORIGIN)).toBe("pass");
    expect(routeOf(req("/anything.json"), ORIGIN)).toBe("pass");
    expect(routeOf({ method: "GET", mode: "cors", url: "https://evil.example/assets/a.js" }, ORIGIN)).toBe(
      "pass",
    );
    expect(routeOf({ method: "GET", mode: "cors", url: "not a url" }, ORIGIN)).toBe("pass");
  });

  it.each([
    "/auth/session",
    "/auth/passkeys",
    "/api/x",
    "/files/x",
    "/upload",
    "/hooks/t",
    "/metrics",
    "/healthz",
    "/ws",
    "/sw.js",
  ])("never intercepts %s, even as a navigation or an asset-looking request", (path) => {
    expect(routeOf(req(path), ORIGIN)).toBe("pass");
    expect(routeOf(req(path, "navigate"), ORIGIN)).toBe("pass");
  });

  it("does not confuse a prefix with a path segment", () => {
    expect(routeOf(req("/authors", "navigate"), ORIGIN)).toBe("navigation");
  });
});

describe("cacheable.rules", () => {
  const res = (over: Partial<Parameters<typeof cacheable>[0]> = {}, control?: string) => ({
    status: 200,
    type: "basic",
    redirected: false,
    headers: { get: (name: string) => (name === "cache-control" ? (control ?? null) : null) },
    ...over,
  });
  it("accepts a plain 200 basic response", () => {
    expect(cacheable(res())).toBe(true);
    expect(cacheable(res({}, "public, max-age=31536000, immutable"))).toBe(true);
  });
  it.each([
    ["404", res({ status: 404 })],
    ["206", res({ status: 206 })],
    ["opaque", res({ type: "opaque" })],
    ["cors", res({ type: "cors" })],
    ["redirected", res({ redirected: true })],
    ["no-store", res({}, "no-store")],
    ["private", res({}, "private, max-age=0")],
    ["NO-STORE upper case", res({}, "No-Store")],
  ])("refuses %s", (_name, response) => {
    expect(cacheable(response)).toBe(false);
  });
});
