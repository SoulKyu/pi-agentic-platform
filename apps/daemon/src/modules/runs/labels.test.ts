import { describe, expect, it } from "vitest";
import { scrubKnownSecrets } from "../audit/index.ts";
import { labelValue } from "./labels.ts";

const label = (raw: string | null | undefined) => labelValue(raw, scrubKnownSecrets);

describe("labelValue", () => {
  it.each([
    "claude-sonnet-4-5",
    "anthropic",
    "accounts/fireworks/models/llama-v3p1",
    "llama3:8b-q4_K_M",
    "gpt-4o@2024+x",
  ])("keeps the plain id %s", (id) => expect(label(id)).toBe(id));

  it("says none for nothing", () => {
    expect(label(null)).toBe("none");
    expect(label(undefined)).toBe("none");
    expect(label("")).toBe("none");
  });

  it.each([
    ['a"} injected{x="1', "a quoted injection"],
    ["line\nbreak", "a newline"],
    ["back\\slash", "a backslash"],
    ["has space", "a space"],
    ["a,b", "a comma"],
    ["x".repeat(65), "65 characters"],
    ["sk-" + "a".repeat(30), "an API key"],
    ["gpt-4o\u2028x", "a line separator"],
    ["/home/alice/models/qwen.gguf", "an absolute path"],
    ["~/models/qwen", "a home path"],
    [".hidden/model", "a dot path"],
    ["a/../b", "a parent segment"],
    ["v1..2", "two dots"],
  ])("replaces %j (%s) by other", (raw) => expect(label(raw)).toBe("other"));

  it("keeps 64 characters", () => expect(label("x".repeat(64))).toBe("x".repeat(64)));

  it("asks the scrubber about a plain value and refuses what it flags", () => {
    expect(labelValue("plainid", () => ({ count: 1 }))).toBe("other");
    expect(labelValue("plainid", () => ({ count: 0 }))).toBe("plainid");
  });
});
