import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpApp } from "../../kernel/http/app.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { mountFonts } from "./routes.ts";
import { createFontsService } from "./service.ts";
import { createFontsStore } from "./store.ts";
import { createFakeClock } from "../../kernel/clock.ts";
import { face, fakeFetcher, GSTATIC, woff2 } from "./testing/fake-fetcher.ts";

const ORIGIN = "http://localhost:7777";
let home: string;
let app: ReturnType<typeof createHttpApp>;
let file = "";
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "pap-fonts-http-"));
  const store = createFontsStore(join(home, "fonts"));
  const service = createFontsService({
    store,
    fetch: fakeFetcher({
      "https://fonts.googleapis.com/css2": face(`${GSTATIC}/fake/v1/a.woff2`),
      [`${GSTATIC}/fake/v1/a.woff2`]: woff2(80),
    }),
    clock: createFakeClock(),
    logger: silentLogger,
  });
  await service.add(testCaller(), "Fake Sans");
  file = store.get("fake-sans")?.files[0] ?? "";
  app = createHttpApp({
    allowedOrigins: new Set([ORIGIN]),
    staticRoot: null,
    logger: silentLogger,
    mount: (hono) => mountFonts(hono, store),
    wsProbe: (c) => c.json({ protocol: 1 }),
  });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("GET /fonts/<slug>/<file>", () => {
  it("serves the generated css and the woff2 with their types, read-only, on the same origin", async () => {
    const css = await app.request("/fonts/fake-sans/font.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("cache-control")).toBe("no-cache");
    expect(file).toMatch(/^[0-9a-f]{16}\.woff2$/);
    const font = await app.request(`/fonts/fake-sans/${file}`);
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(font.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(font.headers.get("content-length")).toBe("80");
    expect((await font.arrayBuffer()).byteLength).toBe(80);
    for (const method of ["POST", "PUT", "DELETE"])
      expect(
        (await app.request("/fonts/fake-sans/font.css", { method, headers: { origin: ORIGIN } })).status,
        method,
      ).toBe(404);
  });

  it("keeps the CSP of every other response: font-src 'self', no external host", async () => {
    const response = await app.request(`/fonts/fake-sans/${file}`);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("font-src 'self';");
    expect(csp).not.toMatch(/google|gstatic|https:/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers 404 for an unknown slug or file, traversal and encodings, with no body detail", async () => {
    for (const path of [
      "/fonts/ghost/font.css",
      "/fonts/fake-sans/ghost.woff2",
      "/fonts/fake-sans/0000000000000000.woff2",
      "/fonts/fake-sans/meta.json",
      "/fonts/fake-sans/..%2f..%2fsecrets%2fvault",
      "/fonts/fake-sans/%2e%2e/font.css",
      "/fonts/..%2ffake-sans/font.css",
      "/fonts/fake-sans/font.css/",
      "/fonts/fake-sans/FONT.CSS",
      "/fonts/FAKE-SANS/font.css",
      "/fonts/fake-sans",
      "/fonts/",
      "/fonts",
    ]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(404);
      expect(await response.json(), path).toEqual({ error: { code: "not_found" } });
    }
  });
});
