import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, type Caller, type Permission } from "@pap/contracts";
import { testCaller } from "../../testing/caller.ts";
import { httpCaller } from "./caller.ts";

const COOKIE = "pap_session=good";

function appWith(permission: Permission, caller: Caller | null = testCaller({ stepUpUntil: 77 })) {
  const authenticate = (header: string | undefined): Caller | null => (header === COOKIE ? caller : null);
  const app = new Hono();
  const via = httpCaller(authenticate);
  app.get("/x", (c) => {
    const found = via(c, permission);
    return found instanceof Response ? found : c.json({ kind: found.kind, stepUpUntil: found.stepUpUntil });
  });
  return app;
}
const get = (app: Hono, headers: Record<string, string> = {}) => app.request("/x", { headers });

describe("httpCaller", () => {
  it("answers 401 unauthenticated without a live cookie", async () => {
    const app = appWith("files:read");
    for (const headers of [undefined, { cookie: "pap_session=stale" }]) {
      const res = await get(app, headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: { code: "unauthenticated" } });
    }
  });

  it("answers 401 to any Authorization header, even beside a valid cookie: HTTP routes are cookie-only", async () => {
    const res = await get(appWith("files:read"), { cookie: COOKIE, authorization: "Bearer pap_abc" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthenticated" } });
  });

  it("answers 403 forbidden to a cookie without the permission", async () => {
    const app = appWith("files:read", testCaller({ permissions: new Set<Permission>(["sessions:read"]) }));
    const res = await get(app, { cookie: COOKIE });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "forbidden" } });
  });

  it("answers 401 to a cookie that resolves to anything but a browser session", async () => {
    const res = await get(appWith("files:read", testCaller({ kind: "token" })), { cookie: COOKIE });
    expect(res.status).toBe(401);
  });

  it("returns the session caller with its step-up", async () => {
    const res = await get(appWith("files:read"), { cookie: COOKIE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "session", stepUpUntil: 77 });
    expect(ALL_PERMISSIONS).toContain("files:read");
  });
});
