import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { isHookRequest } from "./hook-path.ts";
import { originGuard } from "./origin.ts";

const ID = "0b3c1f6e-6a1d-4c11-8d52-5d8e9a7f3b21";
const ORIGIN = "http://localhost:7777";

function app(): Hono {
  const hono = new Hono();
  hono.use("*", originGuard(new Set([ORIGIN]), undefined, isHookRequest));
  hono.all("*", (c) => c.json({ ok: true }));
  return hono;
}
const post = (path: string, origin?: string) =>
  app().request(path, { method: "POST", ...(origin ? { headers: { origin } } : {}) });

describe("originGuard with the hook exemption", () => {
  it("lets the hook path through with no Origin and with a foreign one", async () => {
    expect((await post(`/hooks/${ID}`)).status).toBe(200);
    expect((await post(`/hooks/${ID}`, "https://evil.example")).status).toBe(200);
  });
  it.each([
    "/auth/login",
    "/upload",
    `/hooks/${ID}/../../auth/login`,
    `/hooks/${ID}/`,
    `/hooks/${ID.toUpperCase()}`,
    `/hooks/%2e%2e/auth/login`,
    `/hooks/${ID}/%2e%2e/%2e%2e/auth/login`,
    `/hooks/${ID}%00`,
    `//hooks/${ID}`,
  ])("still needs an allowed Origin for %s", async (path) => {
    expect((await post(path)).status).toBe(403);
    expect((await post(path, "https://evil.example")).status).toBe(403);
  });
  it("lets an allowed Origin through everywhere, and leaves GET alone", async () => {
    expect((await post("/auth/login", ORIGIN)).status).toBe(200);
    expect((await app().request("/auth/login")).status).toBe(200);
  });
  it("exempts only POST", async () => {
    const put = await app().request(`/hooks/${ID}`, { method: "PUT" });
    expect(put.status).toBe(403);
  });
});
