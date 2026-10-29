import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../clock.ts";
import type { Logger } from "../../logger.ts";
import {
  cleanRequestHeaders,
  cleanResponseHeaders,
  rawRefusal,
  rewriteLocation,
  upgradeHead,
} from "./headers.ts";
import {
  BodyTooLarge,
  bodyMeter,
  createBoxSlots,
  createRefusalLog,
  idleWatch,
  PREVIEW_LIMITS,
  tokenRef,
} from "./limits.ts";
import { MAX_TARGET_CHARS, parsePreviewTarget } from "./target.ts";

const T = "A".repeat(42) + "b";

describe("parsePreviewTarget", () => {
  it("reads a service path and keeps rest, query and encoding byte for byte", () => {
    expect(parsePreviewTarget(`/p/${T}/a%2Fb/../c?x=%20&y`)).toEqual({
      kind: "service",
      token: T,
      prefix: `/p/${T}`,
      rest: "/a%2Fb/../c?x=%20&y",
    });
    expect(parsePreviewTarget(`/a/${T}/`)).toEqual({
      kind: "artifact",
      token: T,
      prefix: `/a/${T}`,
      rest: "/",
    });
    expect(parsePreviewTarget(`/p/${T}/?`)).toMatchObject({ rest: "/?" });
  });
  it("answers a missing slash with a redirect to the slashed path, query kept", () => {
    expect(parsePreviewTarget(`/p/${T}?q=1`)).toEqual({
      kind: "slash",
      of: "service",
      token: T,
      location: `/p/${T}/?q=1`,
    });
    expect(parsePreviewTarget(`/a/${T}`)).toMatchObject({
      kind: "slash",
      of: "artifact",
      location: `/a/${T}/`,
    });
  });
  it("refuses everything else", () => {
    const refused: Array<string | undefined> = [
      undefined,
      "",
      "/",
      `/x/${T}/`,
      `//p/${T}/`,
      `/p/${"A".repeat(42)}/`,
      `/p/${"A".repeat(44)}/`,
      `/p/${"A".repeat(42)}%41/`,
      `/p/${T}/a\\b`,
      `/p/${"A".repeat(42)}=/`,
      `/p/${T}/a b`,
      `/p/${T}/a#frag`,
      `/p/${T}/a\0b`,
      `http://evil.test/p/${T}/`,
      "*",
      `/p/${T}/${"a".repeat(MAX_TARGET_CHARS)}`,
    ];
    for (const raw of refused) expect(parsePreviewTarget(raw), String(raw).slice(0, 60)).toBeNull();
  });
  it("reads a double slash after the token as the service's own path", () => {
    expect(parsePreviewTarget(`/p/${T}//x`)).toMatchObject({ kind: "service", rest: "//x" });
  });
  it("accepts a target of exactly 8 KiB", () => {
    const head = `/p/${T}/`;
    expect(parsePreviewTarget(head + "a".repeat(MAX_TARGET_CHARS - head.length))).not.toBeNull();
    expect(parsePreviewTarget(head + "a".repeat(MAX_TARGET_CHARS - head.length + 1))).toBeNull();
  });
});

describe("cleanRequestHeaders", () => {
  const input = { port: 8000, prefix: `/p/${T}`, websocket: false };
  it("drops identity, hop-by-hop, forwarding and Connection-listed headers, keeps the rest", () => {
    expect(
      cleanRequestHeaders(
        {
          cookie: "pap_session=s",
          authorization: "Bearer x",
          "proxy-authorization": "Basic x",
          referer: `https://pap/p/${T}/`,
          host: "pap.example:7778",
          connection: "keep-alive, X-Secret",
          "x-secret": "1",
          "keep-alive": "timeout=5",
          "proxy-connection": "keep-alive",
          te: "trailers",
          trailer: "x",
          "transfer-encoding": "chunked",
          upgrade: "h2c",
          expect: "100-continue",
          "http2-settings": "AAA",
          forwarded: "for=1.2.3.4",
          "x-forwarded-for": "1.2.3.4",
          "x-forwarded-host": "pap.example",
          "x-forwarded-prefix": "/evil",
          "x-real-ip": "1.2.3.4",
          accept: "text/html",
          "content-type": "application/json",
          "content-length": "2",
          origin: "null",
        },
        input,
      ),
    ).toEqual({
      accept: "text/html",
      "content-type": "application/json",
      "content-length": "2",
      origin: "null",
      host: "127.0.0.1:8000",
      "x-forwarded-prefix": `/p/${T}`,
      connection: "close",
    });
  });
  it("a WebSocket keeps its handshake headers and says Upgrade", () => {
    const out = cleanRequestHeaders(
      {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "k",
        "sec-websocket-version": "13",
        cookie: "c=1",
      },
      { ...input, websocket: true },
    );
    expect(out).toEqual({
      "sec-websocket-key": "k",
      "sec-websocket-version": "13",
      host: "127.0.0.1:8000",
      "x-forwarded-prefix": `/p/${T}`,
      connection: "Upgrade",
      upgrade: "websocket",
    });
  });
});

const PAP_SIX = {
  "content-security-policy": "CSP",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-dns-prefetch-control": "off",
  "access-control-allow-origin": "*",
};

describe("cleanResponseHeaders", () => {
  const input = { prefix: `/p/${T}`, port: 8000, requestPath: "/", csp: "CSP" };
  it("keeps the body's description and drops every header that acts on the host", () => {
    const out = cleanResponseHeaders(
      {
        "content-type": "text/html",
        "content-length": "5",
        etag: '"x"',
        vary: "origin",
        "access-control-allow-headers": "x-a",
        "www-authenticate": 'Basic realm="x"',
        "sec-session-registration": "x",
        "set-login": "logged-in",
        "accept-ch": "sec-ch-ua",
        "critical-ch": "sec-ch-ua",
        "speculation-rules": '"/r.json"',
        "activate-storage-access": "retry",
        "origin-agent-cluster": "?1",
        "permissions-policy": "camera=*",
        "cross-origin-opener-policy": "same-origin",
        link: "<https://evil.test>; rel=preconnect",
        "access-control-allow-private-network": "true",
        "set-cookie": ["a=b"],
        "clear-site-data": '"cookies"',
        refresh: "0;url=https://evil.test",
        "x-made-up-2027": "1",
        "content-security-policy": "default-src *",
        "access-control-allow-origin": "https://evil.test",
        "access-control-allow-credentials": "true",
        "strict-transport-security": "max-age=1",
        "alt-svc": "h3=:443",
      },
      input,
    );
    expect(out).toEqual({
      "content-type": "text/html",
      "content-length": "5",
      etag: '"x"',
      vary: "origin",
      "access-control-allow-headers": "x-a",
      ...PAP_SIX,
    });
  });
  it("keeps every allowlisted name", () => {
    const names = [
      "content-type",
      "content-length",
      "content-encoding",
      "content-language",
      "content-disposition",
      "content-range",
      "accept-ranges",
      "etag",
      "last-modified",
      "vary",
      "date",
      "access-control-allow-methods",
      "access-control-allow-headers",
      "access-control-expose-headers",
      "access-control-max-age",
    ];
    const out = cleanResponseHeaders(Object.fromEntries(names.map((name) => [name, "v"])), input);
    for (const name of names) expect(out[name], name).toBe("v");
  });
  it("a kept name the Connection header lists is dropped", () => {
    const out = cleanResponseHeaders({ connection: "etag", etag: '"x"', vary: "origin" }, input);
    expect(out.etag).toBeUndefined();
    expect(out.vary).toBe("origin");
  });
  it("rewrites a Location inside the preview and drops one outside, keeping the status for the caller", () => {
    expect(cleanResponseHeaders({ location: "/login?next=1" }, input).location).toBe(`/p/${T}/login?next=1`);
    expect(cleanResponseHeaders({ location: "https://evil.test/" }, input).location).toBeUndefined();
  });
});

describe("rawRefusal and upgradeHead", () => {
  it("rawRefusal(502) is a bare status line with pap's headers and no set-cookie", () => {
    const text = rawRefusal(502, "CSP");
    expect(text.startsWith("HTTP/1.1 502 Bad Gateway\r\n")).toBe(true);
    expect(text.endsWith("\r\n\r\n")).toBe(true);
    expect(text).toContain("content-security-policy: CSP\r\n");
    expect(text).toContain("content-length: 0\r\n");
    expect(text).toContain("connection: close\r\n");
    expect(text.toLowerCase()).not.toContain("set-cookie");
    expect(rawRefusal(413, "C")).toContain("413 Payload Too Large");
  });
  it("upgradeHead copies the handshake headers only and refuses a header-splitting value", () => {
    const head = upgradeHead({
      "sec-websocket-accept": "acc",
      "sec-websocket-protocol": "chat",
      "set-cookie": ["a=b"],
      "sec-websocket-extensions": "x\r\nset-cookie: a=b",
    });
    expect(head).toBe(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "sec-websocket-accept: acc\r\nsec-websocket-protocol: chat\r\n\r\n",
    );
  });
});

describe("rewriteLocation", () => {
  const input = { prefix: `/p/${T}`, port: 8000, requestPath: "/a/b" };
  const at = (location: string) => rewriteLocation(location, input);
  it("keeps what stays inside the preview, under its prefix", () => {
    expect(at("/login")).toBe(`/p/${T}/login`);
    expect(at("next")).toBe(`/p/${T}/a/next`);
    expect(at("../up")).toBe(`/p/${T}/up`);
    expect(at("?q=1")).toBe(`/p/${T}/a/b?q=1`);
    expect(at("#top")).toBe(`/p/${T}/a/b#top`);
    expect(at("http://127.0.0.1:8000/x?y=1#z")).toBe(`/p/${T}/x?y=1#z`);
    expect(at("http://localhost:8000/x")).toBe(`/p/${T}/x`);
    expect(at("http://[::1]:8000/x")).toBe(`/p/${T}/x`);
  });
  it("drops anything that leaves it", () => {
    const dropped = [
      "https://evil.test/",
      "//evil.test/x",
      "http://127.0.0.1:9000/x",
      "https://127.0.0.1:8000/x",
      "http://127.0.0.1/x",
      "/../../a",
      "/%2e%2e/%2e%2e/a",
      "../../../x",
      "/\\evil",
      "javascript:alert(1)",
      "",
      "/a\r\nSet-Cookie: x=1",
      "/a b",
      `/${"a".repeat(8200)}`,
    ];
    for (const location of dropped) expect(at(location), location.slice(0, 40)).toBeNull();
  });
});

describe("bounds", () => {
  it("the 33rd slot of a box is refused and a place frees once", () => {
    const slots = createBoxSlots(PREVIEW_LIMITS.tunnelsPerBox);
    const taken = Array.from({ length: 32 }, () => slots.take("b"));
    expect(taken.every((release) => release !== null)).toBe(true);
    expect(slots.take("b")).toBeNull();
    expect(slots.take("other")).not.toBeNull();
    const release = taken[0];
    release?.();
    release?.();
    expect(slots.count("b")).toBe(31);
    expect(slots.take("b")).not.toBeNull();
    expect(slots.take("b")).toBeNull();
    for (const free of taken) free?.();
  });
  it("a body at the cap passes and one byte past fails BodyTooLarge", async () => {
    const pass = bodyMeter(10);
    const chunks: Buffer[] = [];
    pass.on("data", (chunk: Buffer) => chunks.push(chunk));
    const ended = new Promise((resolve) => pass.on("end", resolve));
    pass.write(Buffer.alloc(4));
    pass.end(Buffer.alloc(6));
    await ended;
    expect(pass.bytes()).toBe(10);
    const fail = bodyMeter(10);
    const failed = new Promise<unknown>((resolve) => fail.on("error", resolve));
    fail.write(Buffer.alloc(6));
    fail.write(Buffer.alloc(5));
    expect(await failed).toBeInstanceOf(BodyTooLarge);
  });
  it("idle fires at 120 s and not at 100 s after a touch", async () => {
    const clock = createFakeClock();
    let idle = 0;
    const watch = idleWatch(clock, PREVIEW_LIMITS.idleMs, () => idle++);
    await clock.advance(100_000);
    watch.touch();
    await clock.advance(100_000);
    expect(idle).toBe(0);
    await clock.advance(19_999);
    expect(idle).toBe(0);
    await clock.advance(1);
    expect(idle).toBe(1);
    expect(clock.pending()).toBe(0);
  });
  it("stop leaves no timer and never fires", async () => {
    const clock = createFakeClock();
    let idle = 0;
    const watch = idleWatch(clock, 1000, () => idle++);
    watch.stop();
    expect(clock.pending()).toBe(0);
    await clock.advance(5000);
    expect(idle).toBe(0);
  });
});

describe("refusal log", () => {
  const capture = () => {
    const lines: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      error: () => {},
      warn: (msg, fields) => void lines.push({ msg, fields: fields ?? {} }),
      child: () => logger,
    };
    return { lines, logger };
  };
  it("says once per reason and token a minute, with the count, and never the token", async () => {
    const clock = createFakeClock();
    const { lines, logger } = capture();
    const refuse = createRefusalLog(logger, clock);
    refuse("not_found", T);
    refuse("not_found", T);
    refuse("not_found", T);
    refuse("busy", T);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      msg: "preview_refused",
      fields: { reason: "not_found", ref: tokenRef(T), suppressed: 0 },
    });
    expect(JSON.stringify(lines)).not.toContain(T);
    await clock.advance(60_000);
    refuse("not_found", T);
    expect(lines[2]?.fields).toEqual({ reason: "not_found", ref: tokenRef(T), suppressed: 2 });
    refuse("not_found", null);
    expect(lines[3]?.fields.ref).toBe("-");
  });
  it("1100 distinct tokens give 1025 lines, the last t:*", () => {
    const clock = createFakeClock();
    const { lines, logger } = capture();
    const refuse = createRefusalLog(logger, clock);
    for (let n = 0; n < 1100; n++) refuse("not_found", `${String(n).padStart(4, "0")}${T.slice(4)}`);
    expect(lines).toHaveLength(1025);
    expect(lines[1024]?.fields.ref).toBe("t:*");
    expect(lines[1023]?.fields.ref).not.toBe("t:*");
  });
  it("forgets pairs once their minute is over", async () => {
    const clock = createFakeClock();
    const { lines, logger } = capture();
    const refuse = createRefusalLog(logger, clock);
    for (let n = 0; n < 1024; n++) refuse("idle", `${String(n).padStart(4, "0")}${T.slice(4)}`);
    await clock.advance(60_000);
    refuse("idle", `fresh${T.slice(5)}`);
    expect(lines.at(-1)?.fields.ref).toMatch(/^t:[0-9a-f]{12}$/);
  });
});
