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

describe("appearance boot plugin", () => {
  it("links one hashed classic script first in <head>, under /assets/ in a build", async () => {
    const config = await load();
    const plugin = (config.plugins ?? [])
      .flat()
      .find(
        (p) => p && typeof p === "object" && "name" in p && p.name === "pap-appearance-boot",
      ) as unknown as {
      transformIndexHtml(html: string): unknown;
      configResolved(c: { command: string }): void;
    };
    plugin.configResolved({ command: "build" });
    const tags = plugin.transformIndexHtml("<html></html>") as Array<{
      tag: string;
      attrs: { src: string; type?: string };
      injectTo: string;
    }>;
    expect(tags).toHaveLength(1);
    expect(tags[0]?.tag).toBe("script");
    expect(tags[0]?.attrs.src).toMatch(/^\/assets\/appearance-boot-[0-9a-f]{10}\.js$/);
    expect(tags[0]?.attrs.type).toBeUndefined();
    expect(tags[0]?.injectTo).toBe("head-prepend");
  });
});
