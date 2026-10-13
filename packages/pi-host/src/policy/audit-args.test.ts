import { describe, expect, it } from "vitest";
import { auditArgs, UnreadableInput } from "./audit-args.ts";

const identity = (text: string) => text;

describe("auditArgs", () => {
  it("states the command alone for a built-in shell call", () => {
    expect(auditArgs({ command: "ls -la", timeout: 5 }, true, identity)).toBe("ls -la");
  });

  it("states the canonical JSON, keys sorted, for any other call", () => {
    expect(auditArgs({ b: 1, a: [2, { d: 1, c: 2 }] }, false, identity)).toBe(
      '{"a":[2,{"c":2,"d":1}],"b":1}',
    );
    expect(auditArgs({ command: "ls" }, false, identity)).toBe('{"command":"ls"}');
    expect(auditArgs(undefined, false, identity)).toBe("{}");
  });

  it("redacts before it escapes and clips", () => {
    const redact = (text: string) => text.replaceAll("secret-value", "[SECRET:X]");
    expect(auditArgs({ k: "secret-value" }, false, redact)).toBe('{"k":"[SECRET:X]"}');
    // A secret straddling the clip point is still found, because the clip comes last.
    const padded = `${"a".repeat(2040)}secret-value`;
    expect(auditArgs({ command: padded }, true, redact)).toBe(`${"a".repeat(2040)}[SECRET:…(+2)`);
  });

  it("escapes hidden characters as describeCall does", () => {
    expect(auditArgs({ k: "a\u202Eb" }, false, identity)).toBe('{"k":"a\\u{202E}b"}');
    expect(auditArgs({ command: "x\u0007y" }, true, identity)).toBe("x\\u{0007}y");
    expect(auditArgs({ command: `a${" ".repeat(40)}b` }, true, identity)).toBe("a⟨40 spaces⟩b");
  });

  it("clips to 2048 code points with the count of what was cut", () => {
    const out = auditArgs({ command: "😀".repeat(2050) }, true, identity);
    expect(out).toBe(`${"😀".repeat(2048)}…(+2)`);
    expect(auditArgs({ command: "a".repeat(2048) }, true, identity)).toBe("a".repeat(2048));
  });

  it("throws UnreadableInput for what it cannot state", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const input of [cycle, { run: () => 1 }, { n: 10n }, { n: Number.NaN }])
      expect(() => auditArgs(input, false, identity)).toThrow(UnreadableInput);
  });
});
