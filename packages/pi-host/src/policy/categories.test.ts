import type { ToolCategory } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { describeCall, toolCategory } from "./categories.ts";

describe("toolCategory", () => {
  it.each([
    ["read", "read"],
    ["edit", "edit"],
    ["bash", "exec"],
    ["web_fetch", "network"],
    ["some_extension_tool", "unknown"],
    ["mcp__github__create_issue", "unknown"],
    ["READ", "unknown"],
    ["", "unknown"],
  ] satisfies Array<[string, ToolCategory]>)("%j is %s", (tool, expected) => {
    expect(toolCategory(tool)).toBe(expected);
  });
});

describe("describeCall", () => {
  it("shows a shell command as written", () => {
    expect(describeCall("bash", { command: "echo hi", timeout: 5 })).toBe("bash: echo hi");
  });

  it("shows every field of any other tool, even one that has a command field", () => {
    expect(describeCall("deploy", { command: "status", target: "production" })).toBe(
      'deploy: {"command":"status","target":"production"}',
    );
  });

  it("falls back to the JSON of a shell call whose command is not a string", () => {
    expect(describeCall("bash", { command: ["rm", "-rf", "/"] })).toBe('bash: {"command":["rm","-rf","/"]}');
  });

  it("describes a missing input as an empty object", () => {
    expect(describeCall("ls", undefined)).toBe("ls: {}");
  });

  it("clips a payload at 4000 characters and says how long it was", () => {
    const text = describeCall("bash", { command: "x".repeat(4001) });
    expect(text).toBe(`bash: ${"x".repeat(4000)}… (4001 characters)`);
    expect(describeCall("bash", { command: "x".repeat(4000) })).toBe(`bash: ${"x".repeat(4000)}`);
  });
});
