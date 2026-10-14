import { DEFAULT_POLICY_SETTINGS, DenyPattern, HostPattern } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import {
  checkForm,
  clipLabel,
  formOf,
  groupRules,
  parsePatternLines,
  sameSettings,
  shortScope,
} from "./policy-settings.vm.ts";

describe("parsePatternLines", () => {
  it("keeps valid lines, numbers the invalid ones and refuses more than the limit", () => {
    expect(parsePatternLines("sudo *\n\n  \ngit push --force*\nrm\u0000x", DenyPattern, 64)).toEqual({
      values: ["sudo *", "git push --force*"],
      errors: [{ line: 5, reason: "invalid" }],
    });
    const many = Array.from({ length: 65 }, (_, i) => `p${i}`).join("\n");
    expect(parsePatternLines(many, DenyPattern, 64).errors).toEqual([{ line: 65, reason: "too_many" }]);
    expect(parsePatternLines("Example.com\n127.0.0.1\n*.ok.org", HostPattern, 256)).toEqual({
      values: ["*.ok.org"],
      errors: [
        { line: 1, reason: "invalid" },
        { line: 2, reason: "invalid" },
      ],
    });
  });

  it("reads CRLF text and refuses bidi and lookalike blanks", () => {
    expect(parsePatternLines("a *\r\nb *", DenyPattern, 64).values).toEqual(["a *", "b *"]);
    expect(parsePatternLines("a\u202Eb\nc\u200Bd", DenyPattern, 64).errors).toEqual([
      { line: 1, reason: "invalid" },
      { line: 2, reason: "invalid" },
    ]);
  });
});

describe("readOnlyCommands in the form", () => {
  it("is on by default, read from the stored document and sent back by Save", () => {
    expect(formOf({}).readOnlyCommands).toBe(true);
    const off = formOf({ readOnlyCommands: false });
    expect(off.readOnlyCommands).toBe(false);
    expect(checkForm(off).settings?.readOnlyCommands).toBe(false);
  });

  it("counts as a change for sameSettings", () => {
    expect(sameSettings({ readOnlyCommands: false }, { ...DEFAULT_POLICY_SETTINGS })).toBe(false);
  });
});

describe("checkForm", () => {
  const form = formOf(DEFAULT_POLICY_SETTINGS);
  it("builds the settings to send: no host list when the switch is off, the list when it is on", () => {
    expect(checkForm({ ...form, denylistText: "sudo *", hostsText: "a.example" })).toMatchObject({
      valid: true,
      settings: { ...DEFAULT_POLICY_SETTINGS, denylist: ["sudo *"], allowHosts: null },
    });
    expect(checkForm({ ...form, hostsOn: true, hostsText: "" }).settings?.allowHosts).toEqual([]);
    expect(checkForm({ ...form, hostsOn: true, hostsText: "a.example" }).settings?.allowHosts).toEqual([
      "a.example",
    ]);
  });

  it("ignores a bad host list while the switch is off, and refuses it while on", () => {
    expect(checkForm({ ...form, hostsText: "BAD" }).valid).toBe(true);
    expect(checkForm({ ...form, hostsOn: true, hostsText: "BAD" })).toMatchObject({
      valid: false,
      settings: null,
    });
  });

  it("refuses a document over 64 KiB", () => {
    const label = "a".repeat(63);
    const hosts = Array.from(
      { length: 256 },
      (_, i) => `${label}.${label}.${label}.${String(i).padStart(3, "0")}${"b".repeat(54)}`,
    ).join("\n");
    const deny = Array.from({ length: 64 }, (_, i) => `${String(i).padStart(3, "0")}${"x".repeat(253)}`).join(
      "\n",
    );
    const big = checkForm({ ...form, denylistText: deny, hostsOn: true, hostsText: hosts });
    expect(big.valid).toBe(false);
    expect(big.tooLarge).toBe(true);
    expect(big.settings).toBeNull();
    expect(checkForm({ ...form, denylistText: deny }).tooLarge).toBe(false);
    expect(checkForm({ ...form, hostsOn: true, hostsText: hosts }).tooLarge).toBe(false);
  });
});

describe("sameSettings", () => {
  it("compares values, not key order, and null is never the same", () => {
    const a = { ...DEFAULT_POLICY_SETTINGS, denylist: ["x"] };
    expect(sameSettings(DEFAULT_POLICY_SETTINGS, a)).toBe(false);
    expect(sameSettings({ denylist: ["x"] }, a)).toBe(true);
    expect(
      sameSettings(
        { allowHosts: null, denylist: ["x"], defaultMode: a.defaultMode, builtinDenylist: true },
        a,
      ),
    ).toBe(true);
    expect(sameSettings(null, a)).toBe(false);
  });
});

describe("groupRules", () => {
  const rule = (id: string, scope: string, createdAt: number) => ({
    id,
    scope,
    tool: "bash",
    label: id,
    createdAt,
  });
  it("groups by scope, newest group first and newest rule first inside a group", () => {
    const groups = groupRules([rule("a", "/p/one", 1), rule("b", "/p/two", 5), rule("c", "/p/one", 9)]);
    expect(groups.map((g) => [g.scope, g.rules.map((r) => r.id)])).toEqual([
      ["/p/one", ["c", "a"]],
      ["/p/two", ["b"]],
    ]);
  });
});

describe("display helpers", () => {
  it("shows the last two segments of a scope", () => {
    expect(shortScope("/home/me/work/app")).toBe("work/app");
    expect(shortScope("/app")).toBe("app");
    expect(shortScope("")).toBe("");
  });
  it("strips invisible characters and clips on code points", () => {
    expect(clipLabel("a\u202Eb")).toBe("ab");
    const clipped = clipLabel("😀".repeat(500));
    expect([...clipped]).toHaveLength(201);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipLabel("x".repeat(200))).toBe("x".repeat(200));
  });
});
