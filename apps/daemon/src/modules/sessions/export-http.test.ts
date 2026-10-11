import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createHttpApp } from "../../kernel/http/app.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { captureLogger } from "./testing/helpers.ts";
import { contentDispositionOf, EXPORT_CSP, mountExportRoute } from "./export-http.ts";
import { createExports, EXPORT_TTL_MS } from "./exports.ts";

const COOKIE = { cookie: "pap_session=good" };
const PAGE = "<html><script>alert(1)</script></html>";

const beds: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const bed of beds.splice(0)) bed.dispose();
});

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "pap-exports-"));
  const clock = createFakeClock();
  const logs = captureLogger();
  const exports = createExports({ dir, clock, logger: silentLogger });
  const app = createHttpApp({
    allowedOrigins: new Set(["http://localhost:7777"]),
    staticRoot: null,
    logger: silentLogger,
    mount: (hono) =>
      mountExportRoute(hono, {
        exports,
        authenticate: (cookie) => (cookie === "pap_session=good" ? { userId: "u1" } : null),
        logger: logs.logger,
      }),
    wsProbe: (c) => c.text("no"),
  });
  const ready = (sessionId = "s1", ownerId = "u1", title?: string | null) => {
    const { token, path } = exports.prepare(sessionId, ownerId, title);
    writeFileSync(path, PAGE);
    return { token, path, url: `/api/sessions/${sessionId}/export/${token}` };
  };
  const bed = {
    dir,
    clock,
    exports,
    app,
    logs,
    ready,
    dispose: () => {
      exports.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  beds.push(bed);
  return bed;
};

describe("the export download route (ADR 0006)", () => {
  it("answers as an attachment with a sandbox CSP and nosniff, once, then deletes the file", async () => {
    const t = setup();
    const { url, path } = t.ready();
    const reply = await t.app.request(url, { headers: COOKIE });
    expect(reply.status).toBe(200);
    expect(reply.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(reply.headers.get("content-disposition")).toBe('attachment; filename="pap-session.html"');
    expect(reply.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(reply.headers.get("x-content-type-options")).toBe("nosniff");
    expect(reply.headers.get("cache-control")).toBe("no-store");
    expect(reply.headers.get("referrer-policy")).toBe("no-referrer");
    expect(reply.headers.get("content-length")).toBe(String(Buffer.byteLength(PAGE)));
    expect(await reply.text()).toBe(PAGE);
    await vi.waitFor(() => expect(existsSync(path)).toBe(false), { timeout: 2000 });
    expect((await t.app.request(url, { headers: COOKIE })).status).toBe(404);
  });

  it("pins the policy as one exact string", () => {
    expect(EXPORT_CSP).toBe("sandbox; default-src 'none'");
  });

  it("refuses without a session (401), for another owner or session (404), and after it expired (404)", async () => {
    const t = setup();
    const first = t.ready();
    expect((await t.app.request(first.url)).status).toBe(401);
    expect((await t.app.request(first.url, { headers: { cookie: "pap_session=bad" } })).status).toBe(401);
    const other = t.ready("s1", "u2");
    expect((await t.app.request(other.url, { headers: COOKIE })).status).toBe(404);
    const wrongSession = t.ready("s1");
    expect((await t.app.request(wrongSession.url.replace("/s1/", "/s2/"), { headers: COOKIE })).status).toBe(
      404,
    );
    const late = t.ready();
    await t.clock.advance(EXPORT_TTL_MS);
    expect(existsSync(late.path)).toBe(false);
    expect((await t.app.request(late.url, { headers: COOKIE })).status).toBe(404);
  });

  it("gives the same 404 body for a wrong owner, a wrong session, a wrong token and a reused token", async () => {
    const t = setup();
    const mine = t.ready();
    const theirs = t.ready("s1", "u2");
    const bodies = new Set<string>();
    const asked = [theirs.url, mine.url.replace("/s1/", "/s2/"), `/api/sessions/s1/export/${"A".repeat(43)}`];
    for (const url of asked) {
      const reply = await t.app.request(url, { headers: COOKIE });
      expect(reply.status).toBe(404);
      bodies.add(await reply.text());
    }
    expect((await t.app.request(mine.url, { headers: COOKIE })).status).toBe(200);
    const reused = await t.app.request(mine.url, { headers: COOKIE });
    expect(reused.status).toBe(404);
    bodies.add(await reused.text());
    expect([...bodies]).toEqual(['{"error":{"code":"not_found"}}']);
  });

  it("does not use a token up for a caller who has no session", async () => {
    const t = setup();
    const { url } = t.ready();
    expect((await t.app.request(url)).status).toBe(401);
    expect((await t.app.request(url, { headers: COOKIE })).status).toBe(200);
  });

  it("refuses a session id or token of the wrong shape before any lookup, with the same 404", async () => {
    const t = setup();
    const { token } = t.ready();
    const take = vi.spyOn(t.exports, "take");
    const bad = [
      `/api/sessions/s1/export/${token}x`,
      `/api/sessions/s1/export/${token.slice(1)}`,
      `/api/sessions/s1/export/${"%2e".repeat(21)}%2e%2e%2f`,
      `/api/sessions/s1/export/${"A".repeat(42)}!`,
      `/api/sessions/${"s".repeat(129)}/export/${token}`,
      `/api/sessions/s.1/export/${token}`,
      `/api/sessions/s%2F1/export/${token}`,
      `/api/sessions/%2e%2e/export/${token}`,
    ];
    for (const url of bad) {
      const reply = await t.app.request(url, { headers: COOKIE });
      expect(reply.status, url).toBe(404);
      expect(await reply.text(), url).toBe('{"error":{"code":"not_found"}}');
    }
    expect(take).not.toHaveBeenCalled();
    // None of it used the real entry up.
    expect((await t.app.request(`/api/sessions/s1/export/${token}`, { headers: COOKIE })).status).toBe(200);
  });

  it("answers 404 and logs when the file is missing, and the token is spent", async () => {
    const t = setup();
    const { token } = t.exports.prepare("s1", "u1");
    const url = `/api/sessions/s1/export/${token}`;
    const reply = await t.app.request(url, { headers: COOKIE });
    expect(reply.status).toBe(404);
    expect(await reply.text()).toBe('{"error":{"code":"not_found"}}');
    expect(t.logs.lines.filter((line) => line.msg === "export_file_missing")).toHaveLength(1);
    expect((await t.app.request(url, { headers: COOKIE })).status).toBe(404);
    expect(t.clock.pending()).toBe(0);
  });

  it("keeps every other route on the app's own CSP, and gives the export route only its own", async () => {
    const t = setup();
    const own = await t.app.request(t.ready().url, { headers: COOKIE });
    expect(own.headers.get("content-security-policy")).toBe(EXPORT_CSP);
    for (const path of ["/healthz", "/api/nothing", "/ws"]) {
      const reply = await t.app.request(path, { headers: COOKIE });
      const csp = reply.headers.get("content-security-policy") ?? "";
      expect(csp, path).toContain("default-src 'self'");
      expect(csp, path).not.toContain("sandbox");
    }
    // A refused export request is not an export: it keeps the global policy too.
    const refused = await t.app.request(`/api/sessions/s1/export/${"A".repeat(43)}`, { headers: COOKIE });
    expect(refused.headers.get("content-security-policy")).toContain("default-src 'self'");
    const unauthenticated = await t.app.request(`/api/sessions/s1/export/${"A".repeat(43)}`);
    expect(unauthenticated.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("only answers GET", async () => {
    const t = setup();
    const { url } = t.ready();
    const reply = await t.app.request(url, {
      method: "POST",
      headers: { ...COOKIE, origin: "http://localhost:7777" },
    });
    expect(reply.status).toBe(404);
    expect((await t.app.request(url, { headers: COOKIE })).status).toBe(200);
  });

  it("names the file after the session when it has a name, safely, even for a hostile one", async () => {
    const t = setup();
    const hostile = 'a"; filename="evil.exe\r\nSet-Cookie: x=1\\..\\/../é日本\u0000';
    const reply = await t.app.request(t.ready("s1", "u1", hostile).url, { headers: COOKIE });
    const header = reply.headers.get("content-disposition") ?? "";
    expect(header).toMatch(
      /^attachment; filename="[A-Za-z0-9 ._-]+\.html"; filename\*=UTF-8''[A-Za-z0-9%!#$&+.^_`|~-]+\.html$/,
    );
    expect(header).not.toMatch(/[\\/\p{Cc}]/u);
    expect(reply.headers.get("set-cookie")).toBeNull();
    expect(reply.headers.get("content-security-policy")).toBe(EXPORT_CSP);
  });
});

describe("the download's file name", () => {
  const SAFE =
    /^attachment; filename="[A-Za-z0-9 ._-]+\.html"(?:; filename\*=UTF-8''[A-Za-z0-9%!#$&+.^_`|~-]+\.html)?$/;

  it("is a fixed name without a title", () => {
    expect(contentDispositionOf(null)).toBe('attachment; filename="pap-session.html"');
    expect(contentDispositionOf(undefined)).toBe('attachment; filename="pap-session.html"');
    expect(contentDispositionOf("")).toBe('attachment; filename="pap-session.html"');
  });

  it("is an ASCII fallback plus the RFC 5987 form for a title", () => {
    expect(contentDispositionOf("Fix login")).toBe(
      "attachment; filename=\"Fix login.html\"; filename*=UTF-8''Fix%20login.html",
    );
    expect(contentDispositionOf("Café 日本")).toBe(
      "attachment; filename=\"Caf_ __.html\"; filename*=UTF-8''Caf%C3%A9%20%E6%97%A5%E6%9C%AC.html",
    );
    expect(contentDispositionOf("日本語")).toBe(
      "attachment; filename=\"pap-session.html\"; filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.html",
    );
  });

  it("holds no quote, line break, path separator, control character or RFC 5987 delimiter", () => {
    const hostile = [
      '"; filename="x.exe',
      "a\r\nb",
      "../../etc/passwd",
      "..\\..\\windows",
      "a\u0000b\u001fc\u007fd",
      "it's (a) *test*",
      "‮exe.txt",
      "con:aux|nul?<>",
      "\ud800 lone",
      "...",
      "x".repeat(5000),
      "日".repeat(5000),
    ];
    for (const title of hostile) {
      const header = contentDispositionOf(title);
      expect(SAFE.test(header), title.slice(0, 20)).toBe(true);
      expect(header.length <= 700, title.slice(0, 20)).toBe(true);
      const encoded = header.split("filename*=UTF-8''")[1] ?? "";
      expect(encoded, title).not.toMatch(/['()*]/);
      expect(decodeURIComponent(encoded), title).not.toMatch(/[\\/"\p{Cc}\p{Cf}]/u);
    }
  });

  it("does not start with a dot", () => {
    expect(contentDispositionOf("...hidden")).toBe(
      "attachment; filename=\"hidden.html\"; filename*=UTF-8''hidden.html",
    );
    expect(contentDispositionOf("...")).toBe('attachment; filename="pap-session.html"');
  });
});
