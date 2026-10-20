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

  it("withholds a line while no value is known and the collector fails, and uses the last values after", async () => {
    let fail = true;
    const { redact, clock } = make(async () => {
      if (fail) throw new Error(`broken ${VAULT_VALUE}`);
      return [VAULT_VALUE];
    });
    expect(await redact(`x ${VAULT_VALUE}`)).toBe("[line withheld]");
    fail = false;
    await clock.advance(61_000);
    expect(await redact(`x ${VAULT_VALUE}`)).not.toContain(VAULT_VALUE);
    fail = true;
    await clock.advance(61_000);
    expect(await redact(`y ${VAULT_VALUE}`)).not.toContain(VAULT_VALUE);
  });
});
