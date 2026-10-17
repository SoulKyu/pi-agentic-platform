import { describe, expect, it } from "vitest";
import { safeMemberPath, UnsafeArchiveError } from "./member-path.ts";

describe("safeMemberPath", () => {
  it.each([
    ["a", "a"],
    ["agents/one/memory.md", "agents/one/memory.md"],
    ["pi-agent/sessions/a b/c.jsonl", "pi-agent/sessions/a b/c.jsonl"],
    ["agents/one/", "agents/one"],
  ])("accepts %j", (name, expected) => {
    expect(safeMemberPath(name)).toBe(expected);
  });

  it.each([
    [".."],
    ["a/../b"],
    ["./a"],
    ["a//b"],
    ["/etc/passwd"],
    ["a\u0000b"],
    ["a\nb"],
    ["a\u202Eb"],
    ["a\u2028b"],
    ["a�b"],
    ["a".repeat(1025)],
    [""],
    ["/"],
  ])("refuses %j with the one fixed message", (name) => {
    expect(() => safeMemberPath(name)).toThrow(UnsafeArchiveError);
    expect(() => safeMemberPath(name)).toThrow("the archive holds a path that is not safe");
  });

  it("accepts exactly 1024 characters", () => {
    expect(safeMemberPath("a".repeat(1024))).toHaveLength(1024);
  });
});
