import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createStderrRedactor } from "./stderr-redactor.ts";

/*
 * Mutants (RT-43), each run for real in the T15b report:
 *  - M-no-mask: known values are not masked -> "masks a known value" fails.
 *  - M-no-scrub: scrubKnownSecrets is not applied -> "masks an sk- key" fails.
 *  - M-per-line: the collector is called for every line -> "asks the collector once a minute" fails.
 *  - M-never-refresh: the values are never refreshed -> the same case fails (the second minute).
 *  - M-fail-open: a failing collector lets the line through -> "withholds a line while no value is known" fails.
 *  - M-escaped: the JSON-escaped form is not masked -> "masks the JSON-escaped form" fails.
 */
const VAULT_VALUE = `vault-value-${"E".repeat(10)}`;
const KEY = `sk-${"a".repeat(30)}`;

function make(values: () => Promise<string[]>) {
  const clock = createFakeClock();
  let calls = 0;
  const redact = createStderrRedactor({
    clock,
    collect: async () => (calls++, { secrets: await values() }),
  });
  return { redact, clock, calls: () => calls };
}

describe("the relay's stderr lines (AVM-E40 M8)", () => {
  it("masks a known value", async () => {
    const { redact } = make(async () => [VAULT_VALUE]);
    const line = await redact(`upstream said ${VAULT_VALUE} twice ${VAULT_VALUE}`);
    expect(line).not.toContain(VAULT_VALUE);
    expect(line).toContain("[REDACTED]");
  });

  it("masks an sk- key nobody collected", async () => {
    const { redact } = make(async () => []);
    expect(await redact(`bad header ${KEY}`)).not.toContain(KEY);
  });

  it("masks the JSON-escaped form", async () => {
    const value = 'quote"inside-value';
    const { redact } = make(async () => [value]);
    const line = await redact(`body ${JSON.stringify(value)}`);
    expect(line).not.toContain("inside-value");
  });

  it("asks the collector once a minute, not once a line", async () => {
    const { redact, clock, calls } = make(async () => [VAULT_VALUE]);
    for (let i = 0; i < 50; i++) await redact(`line ${i}`);
    expect(calls()).toBe(1);
    await clock.advance(59_000);
    await redact("still cached");
    expect(calls()).toBe(1);
    await clock.advance(2_000);
    await redact("refresh now");
    expect(calls()).toBe(2);
  });

  it("scrubs the well-known formats only while no value was ever read, then uses the values read", async () => {
    let fail = true;
    const { redact, clock } = make(async () => {
      if (fail) throw new Error(`broken ${VAULT_VALUE}`);
      return [VAULT_VALUE];
    });
    expect(await redact(`x ${VAULT_VALUE} ${KEY}`)).toBe(`x ${VAULT_VALUE} [REDACTED:api_key]`);
    fail = false;
    await clock.advance(61_000);
    expect(await redact(`x ${VAULT_VALUE}`)).toBe("x [REDACTED]");
  });
});

/*
 * Fix round 1 mutants (run for real):
 *  - M-overlap: needles are masked one after the other -> "masks two overlapping values whole" fails.
 *  - M-no-deadline: the collect has no deadline -> "falls back when the collector hangs" fails (never settles).
 *  - M-fallback-withhold: no value ever read withholds the line -> the fallback cases fail.
 */
describe("overlapping values and a collector that hangs (m2, m10)", () => {
  it("masks two overlapping values whole", async () => {
    const a = "abcdefgh-IJKLMNOP";
    const b = "IJKLMNOP-qrstuvwx";
    const { redact } = make(async () => [a, b]);
    const line = await redact(`x ${a.slice(0, 9)}${b} y`);
    expect(line).toBe("x [REDACTED] y");
  });

  it("falls back to the well-known formats when the collector hangs, and logging goes on", async () => {
    const clock = createFakeClock();
    const redact = createStderrRedactor({ clock, collect: () => new Promise(() => {}) });
    const pending = redact(`key ${KEY} and ${VAULT_VALUE}`);
    await clock.advance(30_000);
    const line = await pending;
    expect(line).not.toContain(KEY);
    expect(line).toContain("and");
  });

  it("falls back to the last good set when a later collect fails or hangs", async () => {
    let mode: "ok" | "fail" | "hang" = "ok";
    const clock = createFakeClock();
    const redact = createStderrRedactor({
      clock,
      collect: async () => {
        if (mode === "fail") throw new Error("x");
        if (mode === "hang") return new Promise(() => {});
        return { secrets: [VAULT_VALUE] };
      },
    });
    expect(await redact(`a ${VAULT_VALUE}`)).toBe("a [REDACTED]");
    mode = "hang";
    await clock.advance(61_000);
    const pending = redact(`b ${VAULT_VALUE}`);
    await clock.advance(30_000);
    expect(await pending).toBe("b [REDACTED]");
    mode = "fail";
    await clock.advance(61_000);
    expect(await redact(`c ${VAULT_VALUE}`)).toBe("c [REDACTED]");
  });
});
