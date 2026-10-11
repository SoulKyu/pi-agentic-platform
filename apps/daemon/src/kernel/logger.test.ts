import { describe, expect, it } from "vitest";
import { createFakeClock } from "./clock.ts";
import { createLogger, redact } from "./logger.ts";

describe("logger", () => {
  it("writes one JSON line per entry and filters by level", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "info",
      clock: createFakeClock(0),
      write: (line) => lines.push(line),
    });
    logger.debug("hidden");
    logger.child({ component: "auth" }).info("owner_created", { username: "owner" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      time: "1970-01-01T00:00:00.000Z",
      level: "info",
      msg: "owner_created",
      component: "auth",
      username: "owner",
    });
  });

  it("redacts secret-looking keys at any depth, keeps urls, flattens errors", () => {
    expect(
      redact({
        password: "x",
        nested: { apiKey: "k", url: "http://localhost:7777/setup#token=t" },
        err: new Error("boom"),
      }),
    ).toEqual({
      password: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", url: "http://localhost:7777/setup#token=t" },
      err: { name: "Error", message: "boom" },
    });
  });

  it("never lets a deep object escape redaction or break on cycles", () => {
    const cyclic: Record<string, unknown> = { password: "hunter2" };
    cyclic.self = cyclic;
    const deep = { a: { b: { c: { d: { e: { f: { g: { password: "hunter2" } } } } } } } };
    for (const value of [cyclic, deep]) {
      const line = JSON.stringify(redact(value));
      expect(line).not.toContain("hunter2");
    }
  });

  it("keeps time, level and msg authoritative over caller fields", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "info",
      clock: createFakeClock(0),
      write: (line) => lines.push(line),
    });
    logger.info("real", { msg: "fake", level: "debug", time: "never" });
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      time: "1970-01-01T00:00:00.000Z",
      level: "info",
      msg: "real",
    });
  });
});

describe("redaction keys", () => {
  const redacted = [
    "password",
    "Password",
    "passwd",
    "passphrase",
    "pass",
    "secret",
    "clientSecret",
    "token",
    "accessToken",
    "apiToken",
    "refreshToken",
    "sessionToken",
    "x-access-token",
    "apiKey",
    "api_key",
    "APIKey",
    "x-api-key",
    "authorization",
    "Authorization",
    "Set-Cookie",
    "cookie",
    "credentials",
    "privateKey",
    "private_key",
    "signingKey",
    "encryptionKey",
    "hmac",
    "hmacSecret",
    "bearer",
    "jwt",
    "tokens",
    // Plural token lists, whatever the prefix.
    "accessTokens",
    "refresh_tokens",
    "x-api-tokens",
    "accesstokens",
    // Digits after a word.
    "token2",
    "token_2",
    "password1",
    "api_key2",
    "clientSecret2",
    // Keys written in one lower-case run.
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "authtoken",
    "sessiontoken",
    "clientsecret",
    "appsecret",
    "secretkey",
    "secret_key",
    "SecretKey",
    "accesskey",
    "access_key",
    "apikey",
    "APIKEY",
    "apikeys",
    "x-apikey",
    "privatekey",
    "signingkey",
    "encryptionkey",
  ];
  const kept = [
    "bypass",
    "passed",
    "compass",
    "username",
    "url",
    "key",
    "publicKey",
    "tokenizer",
    // Pi's compaction field: a count of tokens before, not a token.
    "tokensBefore",
    "keyboard",
    "apiKeyboard",
    "monkey",
    "secretary",
    "validity",
  ];

  it.each(redacted)("redacts %s", (key) => {
    expect(redact({ [key]: "value" })).toEqual({ [key]: "[REDACTED]" });
  });

  it.each(kept)("keeps %s", (key) => {
    expect(redact({ [key]: "value" })).toEqual({ [key]: "value" });
  });

  it("keeps a numeric tokens counter but redacts a tokens list", () => {
    expect(redact({ tokens: 1234 })).toEqual({ tokens: 1234 });
    expect(redact({ tokens: ["a", "b"] })).toEqual({ tokens: "[REDACTED]" });
  });

  it.each(["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "max_tokens", "accessTokens"])(
    "keeps %s when it holds a count, and redacts it when it holds anything else",
    (key) => {
      expect(redact({ [key]: 42 })).toEqual({ [key]: 42 });
      expect(redact({ [key]: "42" })).toEqual({ [key]: "[REDACTED]" });
      expect(redact({ [key]: ["a", "b"] })).toEqual({ [key]: "[REDACTED]" });
    },
  );
});

describe("a logger that never throws", () => {
  const lineOf = (fields: Record<string, unknown>): Record<string, unknown> => {
    const lines: string[] = [];
    createLogger({ level: "info", clock: createFakeClock(0), write: (line) => lines.push(line) }).info(
      "x",
      fields,
    );
    return JSON.parse(lines[0] ?? "") as Record<string, unknown>;
  };

  it("writes a BigInt as a string and a Date as an ISO string", () => {
    expect(
      lineOf({ big: 12345678901234567890n, at: new Date(86_400_000), bad: new Date(Number.NaN) }),
    ).toMatchObject({
      big: "12345678901234567890",
      at: "1970-01-02T00:00:00.000Z",
      bad: "[Invalid Date]",
    });
  });

  it("replaces a throwing getter with [Unreadable] and keeps the other fields", () => {
    const fields = {
      ok: 1,
      get boom(): string {
        throw new Error("getter exploded");
      },
    };
    expect(lineOf(fields)).toMatchObject({ ok: 1, boom: "[Unreadable]" });
  });

  it("marks cycles as [Circular] but repeats a shared, non-circular object in full", () => {
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    loop.list = [loop];
    const shared = { n: 1 };
    expect(lineOf({ loop, a: shared, b: shared })).toMatchObject({
      loop: { name: "loop", self: "[Circular]", list: ["[Circular]"] },
      a: { n: 1 },
      b: { n: 1 },
    });
  });

  it("caps the keys of an object and the items of an array", () => {
    const big = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`k${index}`, index]));
    const out = redact(big) as Record<string, unknown>;
    expect(Object.keys(out)).toHaveLength(101);
    expect(out["[Truncated]"]).toBe(50);
    const list = redact(Array.from({ length: 150 }, (_, index) => index)) as unknown[];
    expect(list).toHaveLength(101);
    expect(list[100]).toBe("[Truncated]");
  });

  it("survives a getter that throws inside a child logger's bindings", () => {
    const lines: string[] = [];
    const root = createLogger({
      level: "info",
      clock: createFakeClock(0),
      write: (line) => lines.push(line),
    });
    const bindings = {
      get boom(): string {
        throw new Error("getter exploded");
      },
    };
    expect(() => root.child(bindings).info("x")).not.toThrow();
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ msg: "x", boom: "[Unreadable]" });
  });

  it("writes a fixed fallback line when an entry cannot be serialised", () => {
    const lines: string[] = [];
    const clock = { ...createFakeClock(0), now: () => Number.NaN };
    const logger = createLogger({ level: "info", clock, write: (line) => lines.push(line) });
    expect(() => logger.error("x", { a: 1 })).not.toThrow();
    expect(lines).toEqual(['{"level":"error","msg":"log_serialization_failed"}\n']);
  });

  it("does not throw when the sink itself throws", () => {
    const logger = createLogger({
      level: "info",
      clock: createFakeClock(0),
      write: () => {
        throw new Error("EPIPE");
      },
    });
    expect(() => logger.info("x")).not.toThrow();
  });
});
