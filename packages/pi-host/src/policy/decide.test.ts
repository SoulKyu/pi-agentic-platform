import { PolicyRules } from "@pap/contracts";
import { TOOL_CATEGORIES } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { toolCategory } from "./categories.ts";
import { decide, decideEdit } from "./decide.ts";

const interactive = PolicyRules.parse({
  profile: "interactive",
  approvalMode: "auto-accept-edits",
  alwaysAllow: [],
});
// The contract only knows the interactive profile in M1; a rules object from the future must not open anything.
const unattended = { profile: "isolated-task", approvalMode: "auto-accept-edits" } as unknown as PolicyRules;

describe("decide (interactive, auto-accept edits)", () => {
  it.each([
    ["read", "allow"],
    ["grep", "allow"],
    ["find", "allow"],
    ["ls", "allow"],
    ["edit", "allow"],
    ["write", "allow"],
    ["bash", "ask"],
    ["powershell", "ask"],
    ["web_fetch", "ask"],
    ["some_extension_tool", "ask"],
    ["mcp__github__create_issue", "ask"],
  ])("%s → %s", (tool, expected) => {
    expect(decide(toolCategory(tool), interactive)).toBe(expected);
  });
});

describe("decide (unattended)", () => {
  it.each(TOOL_CATEGORIES)(
    "blocks %s: M1 has no unattended rules, so nothing is allowed or asked",
    (category) => {
      expect(decide(category, unattended)).toBe("block");
    },
  );
});

describe("decideEdit", () => {
  it("allows an edit inside the session directory", () => {
    expect(decideEdit(interactive, true)).toBe("allow");
  });

  it("asks (interactive) or blocks (unattended) for an edit outside it", () => {
    expect(decideEdit(interactive, false)).toBe("ask");
    expect(decideEdit(unattended, false)).toBe("block");
    expect(decideEdit(unattended, true)).toBe("block");
  });
});
