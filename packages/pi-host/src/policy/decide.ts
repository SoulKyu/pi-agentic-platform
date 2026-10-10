import type { PolicyRules, ToolCategory } from "@pap/contracts";

export type Decision = "allow" | "ask" | "block";

const INTERACTIVE_AUTO_ACCEPT_EDITS: Readonly<Record<ToolCategory, Decision>> = {
  read: "allow",
  edit: "allow",
  exec: "ask",
  network: "ask",
  "external-write": "ask",
  unknown: "ask",
};

export function decide(category: ToolCategory, rules: PolicyRules): Decision {
  if (rules.profile === "interactive" && rules.approvalMode === "auto-accept-edits") {
    return INTERACTIVE_AUTO_ACCEPT_EDITS[category];
  }
  return "block";
}

// An edit that leaves the session directory is no longer an auto-accepted edit: it is judged like an unclassified call.
export function decideEdit(rules: PolicyRules, insideCwd: boolean): Decision {
  return decide(insideCwd ? "edit" : "unknown", rules);
}
