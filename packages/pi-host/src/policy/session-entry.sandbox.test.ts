import type { PolicyAuditEntry } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createSessionEntries, sessionEntry } from "./session-entry.ts";

describe("sessionEntry of a sandboxed session (M11R27)", () => {
  it.each([
    [false, "sandbox: bwrap (network off)"],
    [true, "sandbox: bwrap (network on)"],
  ])("says the shell is caged, network %s", (network, reason) => {
    expect(sessionEntry(["read", "bash"], "auto-accept-edits", { network }).stages).toEqual([
      { stage: "00", outcome: "pass", reason: "2 tools" },
      { stage: "05", outcome: "pass", reason },
    ]);
  });

  it("keeps saying 'no sandbox profile' without a sandbox", () => {
    expect(sessionEntry(["read"], "read-only").stages[1]).toEqual({
      stage: "05",
      outcome: "skip",
      reason: "no sandbox profile for interactive sessions",
    });
  });

  it("createSessionEntries carries the sandbox into every entry it sends", () => {
    const sent: PolicyAuditEntry[] = [];
    const entries = createSessionEntries((record) => (sent.push(record.entry as PolicyAuditEntry), true), {
      network: true,
    });
    entries.opened(["bash"], "auto-accept-edits");
    entries.agentStart(["bash", "read"], "auto-accept-edits");
    expect(sent.map((entry) => (entry.kind === "session" ? entry.stages[1]?.reason : null))).toEqual([
      "sandbox: bwrap (network on)",
      "sandbox: bwrap (network on)",
    ]);
  });
});
