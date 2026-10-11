import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserConfig } from "vite";

async function load(daemon?: string): Promise<UserConfig> {
  vi.resetModules();
  if (daemon) vi.stubEnv("PAP_DEV_DAEMON", daemon);
  return (await import("../vite.config.ts")).default;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("vite dev server", () => {
  it("proxies the API paths to the daemon and the WebSocket with ws: true (R118)", async () => {
    const proxy = (await load()).server?.proxy;
    expect(proxy?.["/auth"]).toBe("http://127.0.0.1:7777");
    expect(proxy?.["/healthz"]).toBe("http://127.0.0.1:7777");
    expect(proxy?.["/ws"]).toEqual({ target: "ws://127.0.0.1:7777", ws: true });
  });

  it("follows PAP_DEV_DAEMON, over TLS too", async () => {
    expect((await load("http://127.0.0.1:41234")).server?.proxy?.["/ws"]).toEqual({
      target: "ws://127.0.0.1:41234",
      ws: true,
    });
    expect((await load("https://pap.example.test")).server?.proxy?.["/ws"]).toEqual({
      target: "wss://pap.example.test",
      ws: true,
    });
  });

  it("serves on the origin the daemon allows in --dev", async () => {
    const server = (await load()).server;
    expect(server?.port).toBe(5173);
    expect(server?.strictPort).toBe(true);
  });
});

describe("vite build", () => {
  it("never inlines a font as a data: URI, whatever its size, and leaves other assets at Vite's limit (R118)", async () => {
    const inline = (await load()).build?.assetsInlineLimit;
    if (typeof inline !== "function") throw new Error("assetsInlineLimit must be a function");
    const tiny = Buffer.alloc(16);
    expect(inline("/src/fonts/manrope-latin-wght-normal.woff2", tiny)).toBe(false);
    expect(inline("/src/fonts/tiny.woff2", tiny)).toBe(false);
    expect(inline("/src/logo.svg", tiny)).toBeUndefined();
  });
});
