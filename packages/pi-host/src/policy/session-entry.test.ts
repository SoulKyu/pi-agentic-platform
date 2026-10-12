import type { PolicyAuditEntry } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createSessionEntries, sessionEntry } from "./session-entry.ts";

describe("sessionEntry", () => {
  it("says how many tools are active and that no sandbox profile applies", () => {
    expect(sessionEntry(["read", "bash"], "auto-accept-edits")).toEqual({
      kind: "session",
      stages: [
        { stage: "00", outcome: "pass", reason: "2 tools" },
        { stage: "05", outcome: "skip", reason: "no sandbox profile for interactive sessions" },
      ],
      tools: ["read", "bash"],
      toolsTruncated: false,
      mode: "auto-accept-edits",
    });
  });

  it("keeps 256 names of 256 characters at most, and says it cut", () => {
    const names = Array.from({ length: 300 }, (_, i) => `${i}`.padEnd(300, "n"));
    const entry = sessionEntry(names, "read-only");
    expect(entry.tools).toHaveLength(256);
    expect(entry.tools.every((name) => name.length === 256)).toBe(true);
    expect(entry.toolsTruncated).toBe(true);
    expect(entry.stages[0]).toEqual({ stage: "00", outcome: "pass", reason: "300 tools" });
  });

  it("does not say it cut when only a name was clipped", () => {
    expect(sessionEntry(["n".repeat(300)], "read-only").toolsTruncated).toBe(false);
  });
});

describe("createSessionEntries", () => {
  it("sends at open, and again only when the active names changed", () => {
    const sent: PolicyAuditEntry[] = [];
    const entries = createSessionEntries((record) => (sent.push(record.entry as PolicyAuditEntry), true));
    entries.opened(["read", "bash"], "auto-accept-edits");
    expect(sent).toHaveLength(1);
    entries.agentStart(["read", "bash"], "auto-accept-edits");
    expect(sent).toHaveLength(1);
    entries.agentStart(["read", "bash", "mcp__x__y"], "auto-accept-edits");
    expect(sent).toHaveLength(2);
    entries.agentStart(["read", "bash", "mcp__x__y"], "auto-accept-edits");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ kind: "session", tools: ["read", "bash", "mcp__x__y"] });
  });

  it("sends the entry again when the channel dropped it", () => {
    let accept = false;
    const sent: unknown[] = [];
    const entries = createSessionEntries((record) => (accept && sent.push(record), accept));
    entries.opened(["read"], "read-only");
    accept = true;
    entries.agentStart(["read"], "read-only");
    expect(sent).toHaveLength(1);
  });
});
