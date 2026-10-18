import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import { createLogger, silentLogger } from "../logger.ts";
import { createHttpApp } from "./app.ts";
import type { OriginRefused } from "./origin.ts";
import { createStaticHandler, isSpaRoute } from "./static.ts";

const ORIGIN = "http://localhost:7777";
const SECRET = "do not serve";
let root: string;
let web: string;
let secretPath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-http-"));
  web = join(root, "web");
  secretPath = join(root, "secret.txt");
  mkdirSync(join(web, "assets"), { recursive: true });
  mkdirSync(join(root, "outside"));
  writeFileSync(join(web, "index.html"), "<!doctype html><title>pap</title>");
  writeFileSync(join(web, "assets", "app-1234.js"), "console.log('pap')");
  writeFileSync(secretPath, SECRET);
  writeFileSync(join(root, "outside", "inner.txt"), SECRET);
  symlinkSync(secretPath, join(web, "assets", "link.txt"));
  symlinkSync("../secret.txt", join(web, "relative-link.txt"));
  symlinkSync(join(root, "outside"), join(web, "linked-dir"));
  symlinkSync(join(root, "missing.js"), join(web, "assets", "dangling.js"));
  symlinkSync("app-1234.js", join(web, "assets", "alias.js"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const build = (staticRoot: string | null = null, servesTls = false, onOriginRefused?: OriginRefused) =>
  createHttpApp({
    allowedOrigins: new Set([ORIGIN]),
    staticRoot,
    servesTls,
    ...(onOriginRefused ? { onOriginRefused } : {}),
    logger: silentLogger,
    mount: (app) => {
      app.post("/auth/echo", (c) => c.json({ ok: true }));
      app.get("/throw/:status", (c) => {
        throw new HTTPException(Number(c.req.param("status")) as 400, { message: "secret detail" });
      });
    },
    wsProbe: (c) => c.json({ protocol: 1 }),
  });

describe("http app", () => {
  it("answers /healthz and sets nosniff", async () => {
    const response = await build().request("/healthz");
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("sends the CSP exactly as ruled, on API and static responses alike (R74)", async () => {
    const csp =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
      "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
    const app = build(web);
    for (const path of ["/healthz", "/", "/assets/app-1234.js", "/api/nothing"]) {
      expect((await app.request(path)).headers.get("content-security-policy"), path).toBe(csp);
    }
  });

  it("sends HSTS only when the daemon serves TLS, for 180 days and without includeSubDomains (R73)", async () => {
    const plain = await build().request("/healthz");
    expect(plain.headers.get("strict-transport-security")).toBeNull();
    const tls = await build(null, true).request("/healthz");
    expect(tls.headers.get("strict-transport-security")).toBe("max-age=15552000");
  });

  it("rejects a POST without Origin or with a forged Origin", async () => {
    const app = build();
    expect((await app.request("/auth/echo", { method: "POST" })).status).toBe(403);
    expect(
      (await app.request("/auth/echo", { method: "POST", headers: { origin: "http://evil.example" } }))
        .status,
    ).toBe(403);
    expect((await app.request("/auth/echo", { method: "POST", headers: { origin: ORIGIN } })).status).toBe(
      200,
    );
  });

  it("tells the caller which Origin it refused, and only then", async () => {
    const refused: Array<[string, string | undefined]> = [];
    const app = build(null, false, (via, origin) => refused.push([via, origin]));
    await app.request("/auth/echo", { method: "POST" });
    await app.request("/auth/echo", { method: "POST", headers: { origin: "http://evil.example" } });
    await app.request("/auth/echo", { method: "POST", headers: { origin: ORIGIN } });
    await app.request("/healthz", { headers: { origin: "http://evil.example" } });
    expect(refused).toEqual([
      ["http", undefined],
      ["http", "http://evil.example"],
    ]);
  });

  it("guards every unsafe method, not only POST, and leaves safe ones alone", async () => {
    const app = build();
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      expect((await app.request("/healthz", { method })).status).toBe(403);
    }
    expect((await app.request("/healthz", { method: "OPTIONS" })).status).not.toBe(403);
    expect((await app.request("/healthz", { headers: { origin: "http://evil.example" } })).status).toBe(200);
  });

  it("serves the websocket probe route before the static fallback", async () => {
    expect(await (await build(web).request("/ws")).json()).toEqual({ protocol: 1 });
  });

  it("serves hashed assets immutable and index.html revalidated", async () => {
    const app = build(web);
    const asset = await app.request("/assets/app-1234.js");
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
    const index = await app.request("/");
    expect(index.headers.get("cache-control")).toBe("no-cache");
  });

  it("serves the manifest and the icons without a cookie, typed and revalidated (M12R27)", async () => {
    mkdirSync(join(web, "icons"));
    writeFileSync(join(web, "manifest.webmanifest"), '{"name":"pap"}');
    writeFileSync(join(web, "icons", "icon-192.png"), "png");
    const app = build(web);
    for (const [path, type] of [
      ["/manifest.webmanifest", "application/manifest+json"],
      ["/icons/icon-192.png", "image/png"],
    ] as const) {
      const response = await app.request(path);
      expect(
        [response.status, response.headers.get("content-type"), response.headers.get("cache-control")],
        path,
      ).toEqual([200, type, "no-cache"]);
    }
  });

  it("falls back to index.html for app routes and 404s missing files", async () => {
    const app = build(web);
    expect(await (await app.request("/s/abc")).text()).toContain("<title>pap</title>");
    expect((await app.request("/assets/missing.js")).status).toBe(404);
  });

  it("serves a symlink that stays inside the root", async () => {
    expect(await (await build(web).request("/assets/alias.js")).text()).toBe("console.log('pap')");
  });

  it("never lets a path under a reserved prefix fall through to the SPA", async () => {
    const app = build(web);
    const reserved = ["/auth", "/api", "/files", "/upload", "/hooks", "/metrics", "/ws", "/fonts"];
    for (const prefix of reserved) {
      for (const path of [prefix, `${prefix}/`, `${prefix}/nothing`, `${prefix}/a/b`]) {
        for (const method of ["GET", "HEAD"]) {
          const response = await app.request(path, { method });
          expect(response.status, `${method} ${path}`).toBe(path === "/ws" ? 200 : 404);
        }
      }
      expect(await (await app.request(`${prefix}/nothing`)).json()).toEqual({ error: { code: "not_found" } });
    }
    for (const path of ["/auth%2Fnothing", "/api%2fx", "/%61uth/nothing"]) {
      expect((await app.request(path)).status, path).toBe(404);
    }
    const post = await app.request("/api/nothing", { method: "POST", headers: { origin: ORIGIN } });
    expect([post.status, await post.json()]).toEqual([404, { error: { code: "not_found" } }]);
    for (const path of ["/authors", "/api-docs", "/files-x", "/ws2"]) {
      expect(await (await app.request(path)).text(), path).toContain("<title>pap</title>");
    }
  });

  it("maps a 413 or 400 HTTPException to its fixed code instead of a 500", async () => {
    const app = build();
    const body = async (status: number) => {
      const response = await app.request(`/throw/${status}`);
      const text = await response.text();
      expect(text).not.toContain("secret detail");
      return [response.status, JSON.parse(text)];
    };
    expect(await body(413)).toEqual([413, { error: { code: "payload_too_large" } }]);
    expect(await body(400)).toEqual([400, { error: { code: "bad_request" } }]);
    expect(await body(418)).toEqual([500, { error: { code: "internal" } }]);
  });

  it("answers 404 with a fixed body when there is no static root", async () => {
    const response = await build().request("/s/abc");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found" } });
  });
});

describe("static path safety", () => {
  const attacks = (): string[] => [
    "/assets/..%2f..%2fsecret.txt",
    "/..%2fsecret.txt",
    "/..%2f..%2f..%2fsecret.txt",
    "/..%2f",
    "/%2e%2e/secret.txt",
    "/assets/%2e%2e/%2e%2e/secret.txt",
    "/%00",
    "/%00.txt",
    "/index.html%00.png",
    "/%252e%252e%252fsecret.txt",
    "/%252e%252e%252f",
    "/assets/%252e%252e%252f%252e%252e%252fsecret.txt",
    "/..%5csecret.txt",
    "/..%5c..%5c",
    "/..\\secret.txt",
    "/assets/..\\..\\secret.txt",
    `/${secretPath}`,
    `//${secretPath}`,
    `/${secretPath.replaceAll("/", "%2f")}`,
    `/%2f${secretPath.replaceAll("/", "%2f")}`,
    "//etc/passwd",
    "/assets/link.txt",
    "/relative-link.txt",
    "/linked-dir/inner.txt",
    "/assets/dangling.js",
  ];

  it("answers every traversal, encoding, absolute path and escaping symlink with a bare 404", async () => {
    const app = build(web);
    for (const path of attacks()) {
      const response = await app.request(path);
      const body = await response.text();
      expect(response.status, path).toBe(404);
      expect(JSON.parse(body), path).toEqual({ error: { code: "not_found" } });
      expect(body, path).not.toContain(SECRET);
      expect(body, path).not.toContain(root);
    }
  });

  it("refuses the same inputs at the handler, including raw dot segments HTTP clients may send", () => {
    const serve = createStaticHandler(web);
    for (const path of [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/assets/..",
      "/assets/./app-1234.js",
      "../secret.txt",
      secretPath,
      "/assets/\0",
      "/assets/%2e%2e/app-1234.js",
      "/assets/%E0%A4%A",
      "//assets/app-1234.js",
    ]) {
      expect(serve(path), path).toBeNull();
    }
    expect(serve("/assets/app-1234.js")).not.toBeNull();
    expect(serve("assets/app-1234.js")).not.toBeNull();
  });

  it("only lets plain navigation paths fall back to the SPA", () => {
    for (const path of ["/", "/s/abc", "/settings/models", "/s/abc%20d"])
      expect(isSpaRoute(path), path).toBe(true);
    for (const path of ["/assets/x", "/a.js", "/%00", "/a\\b", "/a/../b", "/a//b", "/%252e", "/%E0%A4%A"]) {
      expect(isSpaRoute(path), path).toBe(false);
    }
  });

  it("never lets a forged forwarded header change the origin check or what gets logged", async () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      clock: createFakeClock(0),
      write: (line) => lines.push(line),
    });
    const app = createHttpApp({
      allowedOrigins: new Set([ORIGIN]),
      staticRoot: null,
      logger,
      mount: (hono) => {
        hono.post("/auth/echo", (c) => c.json({ ok: true }));
        hono.get("/boom", () => {
          throw new Error("secret detail /home/owner/.pap");
        });
      },
      wsProbe: (c) => c.json({ protocol: 1 }),
    });
    const forged = {
      "x-forwarded-proto": "https",
      "x-forwarded-for": "1.2.3.4",
      "x-forwarded-host": "localhost:7777",
      forwarded: "for=1.2.3.4;proto=https;host=localhost:7777",
    };
    const secureOrigin = ORIGIN.replace("http:", "https:");
    for (const origin of [undefined, secureOrigin, "http://1.2.3.4:7777"]) {
      const headers = origin ? { ...forged, origin } : forged;
      expect((await app.request("/auth/echo", { method: "POST", headers })).status, String(origin)).toBe(403);
    }
    expect(
      (await app.request("/auth/echo", { method: "POST", headers: { ...forged, origin: ORIGIN } })).status,
    ).toBe(200);

    const failure = await app.request("/boom", { headers: forged });
    const text = await failure.text();
    expect(failure.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: { code: "internal" } });
    expect(text).not.toContain("secret detail");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("http_error");
    expect(lines[0]).not.toContain("1.2.3.4");
    expect(lines[0]).not.toContain("https");
  });
});

describe("a route's own CSP (ADR 0006)", () => {
  const withOwn = () =>
    createHttpApp({
      allowedOrigins: new Set([ORIGIN]),
      staticRoot: null,
      logger: silentLogger,
      mount: (app) => {
        app.get("/own", (c) => {
          c.set("ownCsp", "sandbox; default-src 'none'");
          return c.text("own");
        });
        app.get("/plain", (c) => c.text("plain"));
        app.get("/own-error", (c) => {
          c.set("ownCsp", "sandbox; default-src 'none'");
          throw new Error("boom");
        });
      },
      wsProbe: (c) => c.text("ws"),
    });

  it("gives exactly that policy to the route that sets it, and the global one to every other", async () => {
    const app = withOwn();
    const own = await app.request("/own");
    expect(own.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(own.headers.getSetCookie()).toEqual([]);
    for (const path of ["/plain", "/healthz", "/missing", "/ws"]) {
      const csp = (await app.request(path)).headers.get("content-security-policy") ?? "";
      expect(csp, path).toContain("default-src 'self'");
      expect(csp, path).toContain("frame-ancestors 'none'");
      expect(csp, path).not.toContain("sandbox");
    }
  });

  it("does not let a route that failed keep its own policy on the error page", async () => {
    const reply = await withOwn().request("/own-error");
    expect(reply.status).toBe(500);
    expect(reply.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("does not carry the policy over from one request to the next", async () => {
    const app = withOwn();
    await app.request("/own");
    expect((await app.request("/plain")).headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
  });
});

describe("what the error log keeps of an export URL", () => {
  it("never writes the single-use token of /api/sessions/:id/export/:token", async () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      clock: createFakeClock(0),
      write: (line) => lines.push(line),
    });
    const token = "T".repeat(43);
    const app = createHttpApp({
      allowedOrigins: new Set([ORIGIN]),
      staticRoot: null,
      logger,
      mount: (hono) => {
        hono.get("/api/sessions/:id/export/:token", () => {
          throw new Error("database is locked");
        });
      },
      wsProbe: (c) => c.json({ protocol: 1 }),
    });
    expect((await app.request(`/api/sessions/s1/export/${token}`)).status).toBe(500);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(token);
    expect(lines[0]).toContain("/api/sessions/s1/export/[redacted]");
  });
});
