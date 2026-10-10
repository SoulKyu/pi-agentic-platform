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
