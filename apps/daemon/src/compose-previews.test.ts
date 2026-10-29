import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { composePreviews, type PreviewsConfig } from "./compose-previews.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { captureLogger } from "./testing/capture-logger.ts";
import { httpRequest } from "./testing/http-client.ts";
import { PREVIEW_TOKEN_LIMITS, createPreviewTokens } from "./modules/previews/index.ts";

type Closers = Parameters<typeof composePreviews>[1];
const closers: Closers = [];
afterEach(async () => {
  for (const closer of closers.splice(0).reverse()) await closer.close();
});

const config = (over: Partial<PreviewsConfig> = {}): PreviewsConfig => ({
  host: "127.0.0.1",
  tls: null,
  previewPort: 0,
  previewOrigin: null,
  publicOrigin: "http://localhost:7777",
  allowedOrigins: new Set(["http://localhost:7777", "http://127.0.0.1:7777"]),
  ...over,
});

async function start(over: Partial<PreviewsConfig> = {}) {
  const { logger, lines } = captureLogger();
  const clock = createFakeClock();
  const previews = await composePreviews({ config: config(over), clock, logger }, closers);
  return { previews, lines, clock };
}

describe("composePreviews", () => {
  it("the default origin is the public origin with the bound port", async () => {
    const { previews } = await start();
    expect(previews.origin).toMatch(/^http:\/\/localhost:\d+$/);
    expect(previews.origin).not.toBe("http://localhost:7777");
    const port = Number(new URL(previews.origin ?? "").port);
    const reply = await httpRequest(`http://127.0.0.1:${port}/`);
    expect(reply.status).toBe(404);
    expect(String(reply.headers["content-security-policy"])).toMatch(/^sandbox /);
  });

  it("PAP_PREVIEW_ORIGIN wins", async () => {
    const { previews } = await start({ previewOrigin: "https://preview.example" });
    expect(previews.origin).toBe("https://preview.example");
  });

  it("serves nothing until bind: every token is unknown", async () => {
    const { previews } = await start();
    const port = Number(new URL(previews.origin ?? "").port);
    expect((await httpRequest(`http://127.0.0.1:${port}/a/${"A".repeat(43)}/`)).status).toBe(404);
  });

  it("bind gives the listener its grants: an artifact minted through the bound tokens is served", async () => {
    const { previews } = await start();
    previews.bind({ entryText: async () => null });
    const { token } = previews.tokens.mintArtifact({
      ownerId: "u1",
      sessionId: "s1",
      entryId: "e1",
      fenceIndex: 0,
      html: "<p>hi</p>",
    });
    const port = Number(new URL(previews.origin ?? "").port);
    const reply = await httpRequest(`http://127.0.0.1:${port}/a/${token}/`);
    expect(reply.status).toBe(200);
    expect(reply.body).toBe("<p>hi</p>");
  });

  it("bind returns the previews handlers with no VM stack: the list is empty and open is box_stopped", async () => {
    const { previews } = await start();
    const bound = previews.bind({ entryText: async () => null });
    const ctx = {
      caller: {
        userId: "u1",
        permissions: new Set(["sessions:operate"]),
        kind: "session",
        credentialId: "c",
        stepUpUntil: 0,
      },
      connectionId: "c",
      openSubscription: () => "sub",
      closeSubscription: () => undefined,
    } as never;
    const box = { kind: "project", id: "0b1c2d3e-0000-4000-8000-000000000001" } as const;
    expect(await bound.rpc["previews.list"]({ box }, ctx)).toEqual({ services: [] });
    await expect(bound.rpc["previews.open"]({ box, name: "site" }, ctx)).rejects.toMatchObject({
      code: "box_stopped",
    });
  });

  it("a held port logs preview_listener_unavailable once and leaves no origin", async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    try {
      const { previews, lines } = await start({ previewPort: (holder.address() as AddressInfo).port });
      expect(previews.origin).toBeNull();
      const said = lines.filter((line) => line.msg === "preview_listener_unavailable");
      expect(said).toHaveLength(1);
      expect(said[0]).toMatchObject({ code: "EADDRINUSE" });
      previews.bind({ entryText: async () => null });
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  it("sweeps the tokens every renewMs on the kernel clock until it is closed", async () => {
    let sweeps = 0;
    const tokens = createPreviewTokens(createFakeClock());
    const spy = {
      ...tokens,
      sweep: () => {
        sweeps++;
        tokens.sweep();
      },
    };
    const { logger } = captureLogger();
    const clock = createFakeClock();
    await composePreviews({ config: config(), clock, logger }, closers, { tokens: spy });
    await clock.advance(PREVIEW_TOKEN_LIMITS.renewMs * 3);
    expect(sweeps).toBe(3);
    for (const closer of closers.splice(0).reverse()) await closer.close();
    await clock.advance(PREVIEW_TOKEN_LIMITS.renewMs * 3);
    expect(sweeps).toBe(3);
  });
});
