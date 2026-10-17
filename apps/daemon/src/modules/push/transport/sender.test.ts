import { createPublicKey, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../kernel/clock.ts";
import { silentLogger } from "../../../kernel/logger.ts";
import { decryptPayload } from "../testing/decrypt.ts";
import {
  createTestBrowser,
  startFakePushService,
  type FakePushService,
  type TestBrowser,
} from "../testing/fake-push-service.ts";
import { BED_SUBJECT, openHttpsBed, READY, type HttpsBed } from "../testing/https-bed.ts";
import type { SendOutcome } from "../service.ts";
import { encryptPayload } from "./encrypt.ts";
import { createHttpsTransport } from "./https-transport.ts";

vi.mock("./encrypt.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./encrypt.ts")>();
  return { ...real, encryptPayload: vi.fn(real.encryptPayload) };
});

const OPTS = { ttlSeconds: 86_400, urgency: "high" as const, topic: "AbCdEfGhIjKlMnOpQrStUv" };
const PLAINTEXT = Buffer.from(
  '{"v":1,"id":"x","cls":"approval","title":"pap","body":"A request is waiting.","ts":1}',
);
let fake: FakePushService;
let bed: HttpsBed;
let browser: TestBrowser;
beforeEach(async () => {
  fake = await startFakePushService();
  bed = openHttpsBed();
  browser = createTestBrowser();
});
afterEach(async () => {
  bed.close();
  await fake.close();
});

const send = (
  over: { signal?: AbortSignal; plaintext?: Buffer; endpoint?: string } = {},
): Promise<SendOutcome> =>
  bed.transport.send(
    browser.target(over.endpoint ?? `${fake.url}/push/secret-path-123`),
    over.plaintext ?? PLAINTEXT,
    OPTS,
    over.signal ?? new AbortController().signal,
  );

describe("the guarded sender: the request", () => {
  it("sends-encrypted-request: aes128gcm, one encryption, a VAPID header, ttl, urgency and topic as passed", async () => {
    expect(await send()).toEqual({ kind: "ok" });
    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    if (request === undefined) throw new Error("no request");
    expect(request.path).toBe("/push/secret-path-123");
    expect(request.headers["content-encoding"]).toBe("aes128gcm");
    expect(request.headers["content-type"]).toBe("application/octet-stream");
    expect(request.headers.ttl).toBe("86400");
    expect(request.headers.urgency).toBe("high");
    expect(request.headers.topic).toBe(OPTS.topic);
    expect(request.headers["content-length"]).toBe(String(request.body.length));
    // opens to the exact plaintext: a double encryption would not
    expect(decryptPayload(request.body, browser.ecdh, browser.authSecret).equals(PLAINTEXT)).toBe(true);

    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(
      request.headers.authorization ?? "",
    );
    expect(match, "the header is 'vapid t=<jwt>, k=<key>'").not.toBeNull();
    const [, head = "", body = "", signature = "", key = ""] = match ?? [];
    expect(key).toBe(bed.identity.publicKey);
    const point = Buffer.from(key, "base64url");
    const publicKey = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: point.subarray(1, 33).toString("base64url"),
        y: point.subarray(33).toString("base64url"),
      },
      format: "jwk",
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${head}.${body}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as {
      aud: string;
      sub: string;
      exp: number;
    };
    expect(claims.aud).toBe(fake.url);
    expect(claims.sub).toBe(BED_SUBJECT);
    expect(claims.exp).toBe(bed.clock.now() / 1000 + 12 * 3600);
    // production never passes the RFC vector's fixed keys: every message has a fresh server key and salt
    expect(vi.mocked(encryptPayload).mock.lastCall).toHaveLength(3);
  });

  it("a topic that is not 1 to 32 url-safe characters is refused before anything is sent", async () => {
    for (const topic of ["", "x".repeat(33), "has space", "new\nline"]) {
      const outcome = await bed.transport.send(
        browser.target(`${fake.url}/p`),
        PLAINTEXT,
        { ...OPTS, topic },
        new AbortController().signal,
      );
      expect(outcome).toEqual({ kind: "refused", reason: "bad_topic" });
    }
    expect(fake.connections()).toBe(0);
  });
});

describe("the guarded sender: what the push service answers", () => {
  const cases: Array<[number, Record<string, string>, SendOutcome]> = [
    [201, {}, { kind: "ok" }],
    [202, {}, { kind: "ok" }],
    [404, {}, { kind: "gone" }],
    [410, {}, { kind: "gone" }],
    [429, { "retry-after": "30" }, { kind: "retry", afterMs: 30_000 }],
    [429, { "retry-after": "99999" }, { kind: "retry", afterMs: 3_600_000 }],
    [429, { "retry-after": "0" }, { kind: "retry", afterMs: 0 }],
    [429, { "retry-after": "x" }, { kind: "retry" }],
    [429, { "retry-after": "1.5" }, { kind: "retry" }],
    [429, { "retry-after": "-3" }, { kind: "retry" }],
    [429, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }, { kind: "retry" }],
    [500, {}, { kind: "retry" }],
    [502, {}, { kind: "retry" }],
    [400, {}, { kind: "rejected", status: 400 }],
    [401, {}, { kind: "rejected", status: 401 }],
    [403, {}, { kind: "rejected", status: 403 }],
    [413, {}, { kind: "rejected", status: 413 }],
  ];
  it.each(cases)("status %i %j maps to %j", async (status, headers, expected) => {
    fake.respondNext(status, headers);
    expect(await send()).toEqual(expected);
  });

  it.each([301, 307])(
    "redirect-is-not-followed: a %i is rejected and no second request arrives",
    async (status) => {
      fake.respondNext(status, { location: `${fake.url}/elsewhere` });
      expect(await send()).toEqual({ kind: "rejected", status });
      await fake.settled();
      expect(fake.requests.map((request) => request.path)).toEqual(["/push/secret-path-123"]);
    },
  );

  it("a connection that is refused is a retry", async () => {
    expect(await send({ endpoint: "http://127.0.0.1:1/x" })).toEqual({ kind: "retry" });
  });

  it("a 401 or 403 is counted and logged once a day with a hash of the host, never the endpoint", async () => {
    fake.respondNext(403);
    fake.respondNext(401);
    await send();
    await send();
    const keyLines = () => bed.lines.filter((line) => line.msg === "push_key_rejected");
    expect(keyLines()).toHaveLength(1);
    expect(keyLines()[0]).toMatchObject({ count: 1, host: expect.stringMatching(/^h:[0-9a-f]{12}$/) });
    fake.respondNext(403);
    await bed.clock.advance(24 * 3600_000);
    await send();
    expect(keyLines()).toHaveLength(2);
    expect(keyLines()[1]).toMatchObject({ count: 2 });
    expect(JSON.stringify(bed.lines)).not.toContain("127.0.0.1");
  });
});

describe("the guarded sender: deadline, body and logs", () => {
  it("deadline: an aborted signal cuts a request that never answers, and the service sees it close", async () => {
    fake.hangNext();
    const controller = new AbortController();
    const pending = send({ signal: controller.signal });
    await fake.received(1);
    controller.abort();
    expect(await pending).toEqual({ kind: "retry" });
    await fake.settled();
  });

  it("an already aborted signal is a retry and connects to nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await send({ signal: controller.signal })).toEqual({ kind: "retry" });
    expect(fake.requests).toHaveLength(0);
  });

  it("big-or-endless-body (smoke): a huge response over a real socket is cut, never read to the end", async () => {
    const total = 64 * 1024 * 1024;
    fake.respondBigNext(200, total);
    expect(await send()).toEqual({ kind: "ok" });
    await fake.settled();
    expect(fake.bytesSent()).toBeLessThan(total);
    expect(JSON.stringify(bed.lines)).not.toContain("xxxxxxxx");
  });

  it("no-body-in-logs: a response body never reaches a log line, and neither does the endpoint", async () => {
    fake.respondNext(400, {}, "SECRET-BODY-123");
    expect(await send()).toEqual({ kind: "rejected", status: 400 });
    const text = JSON.stringify(bed.lines);
    expect(text).not.toContain("SECRET-BODY-123");
    expect(text).not.toContain("secret-path-123");
    expect(text).not.toContain("http");
    const line = bed.lines.find((entry) => entry.msg === "push_send");
    expect(line).toMatchObject({
      h: expect.stringMatching(/^h:[0-9a-f]{12}$/),
      outcome: "rejected",
      status: 400,
    });
    expect(Object.keys(line ?? {}).sort()).toEqual(["h", "level", "msg", "outcome", "status", "time"]);
  });
});

describe("the guarded sender never throws", () => {
  const off = (): HttpsBed => openHttpsBed({ loopbackForTests: false });

  it("http with the loopback switch off, an invalid URL and a damaged key are outcomes that log no endpoint", async () => {
    const strict = off();
    try {
      const run = (endpoint: string, p256dh = browser.p256dh) =>
        strict.transport.send(
          { ...browser.target(endpoint), p256dh },
          PLAINTEXT,
          OPTS,
          new AbortController().signal,
        );
      expect(await run("http://127.0.0.1:1/x")).toEqual({ kind: "refused", reason: "endpoint" });
      expect(await run("not a url at all")).toEqual({ kind: "refused", reason: "endpoint" });
      expect(await run("https://push.example.net/x", "short")).toEqual({
        kind: "refused",
        reason: "bad_keys",
      });
      const damaged = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url");
      expect(await run("https://push.example.net/x", damaged)).toEqual({
        kind: "refused",
        reason: "bad_keys",
      });
      expect(JSON.stringify(strict.lines)).not.toContain("http");
      expect(JSON.stringify(strict.lines)).not.toContain("not a url");
    } finally {
      strict.close();
    }
  });

  it("a bad auth secret is refused as bad_keys", async () => {
    const outcome = await bed.transport.send(
      { ...browser.target(`${fake.url}/p`), auth: "A".repeat(23) },
      PLAINTEXT,
      OPTS,
      new AbortController().signal,
    );
    expect(outcome).toEqual({ kind: "refused", reason: "bad_keys" });
    expect(fake.connections()).toBe(0);
  });

  it("an encryptPayload that throws is an outcome; only the error class is logged", async () => {
    vi.mocked(encryptPayload).mockImplementationOnce(() => {
      throw new TypeError("boom http://leak.example/secret");
    });
    expect(await send()).toEqual({ kind: "refused", reason: "internal" });
    const text = JSON.stringify(bed.lines);
    expect(text).toContain("TypeError");
    expect(text).not.toContain("leak.example");
    expect(text).not.toContain("http");
    expect(fake.connections()).toBe(0);
  });

  it("a RangeError from the encryption and an invalid-public-key error are refusals, not internal errors", async () => {
    vi.mocked(encryptPayload).mockImplementationOnce(() => {
      throw new RangeError("payload_too_large");
    });
    expect(await send()).toEqual({ kind: "refused", reason: "payload_too_large" });
    vi.mocked(encryptPayload).mockImplementationOnce(() => {
      throw Object.assign(new Error("Public key is not valid for specified curve"), {
        code: "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY",
      });
    });
    expect(await send()).toEqual({ kind: "refused", reason: "bad_keys" });
    expect(await send({ plaintext: Buffer.alloc(4000) })).toEqual({
      kind: "refused",
      reason: "payload_too_large",
    });
    expect(fake.connections()).toBe(0);
  });
});

describe("status()", () => {
  const vapid = (): Parameters<typeof createHttpsTransport>[0]["vapid"] => ({
    kind: "ready",
    minted: false,
    identity: { publicKey: "PUB", keyId: "id", sign: () => "t=a.b.c, k=PUB" },
  });
  const base = {
    subject: BED_SUBJECT,
    clock: createFakeClock(),
    logger: silentLogger,
    loopbackForTests: false,
    hosts: [],
  };

  it("is on only with a ready key and a readiness that is not insecure_http", () => {
    expect(createHttpsTransport({ ...base, vapid: vapid(), readiness: READY }).status()).toEqual({
      on: true,
      reason: null,
      publicKey: "PUB",
    });
    expect(
      createHttpsTransport({
        ...base,
        vapid: vapid(),
        readiness: { status: "insecure_http", origin: "http://pap.example.net", hint: "h" },
      }).status(),
    ).toEqual({ on: false, reason: "insecure_http", publicKey: "PUB" });
    expect(
      createHttpsTransport({
        ...base,
        vapid: { kind: "off", reason: "keys_unreadable" },
        readiness: READY,
      }).status(),
    ).toEqual({ on: false, reason: "keys_unreadable", publicKey: null });
    expect(createHttpsTransport({ ...base, vapid: null, readiness: READY }).status()).toEqual({
      on: false,
      reason: null,
      publicKey: null,
    });
  });

  it("an off transport refuses a send", async () => {
    const transport = createHttpsTransport({ ...base, vapid: null, readiness: READY });
    expect(
      await transport.send(
        browser.target("https://push.example.net/x"),
        PLAINTEXT,
        OPTS,
        new AbortController().signal,
      ),
    ).toEqual({
      kind: "refused",
      reason: "off",
    });
  });
});
