import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostBed, toolText } from "./testing/host-bed.ts";

// The worker-level half of "fail closed on bad rules" (spec C §8.1): the bed sends records the daemon never would.
const READ_A = { toolCalls: [{ name: "read", args: { path: "a.txt" }, id: "r" }] };
const WORKER = { timeoutMs: 30_000 };

let bed: ReturnType<typeof createHostBed>;
beforeEach(() => {
  bed = createHostBed();
  writeFileSync(join(bed.cwd, "a.txt"), "hello");
});
afterEach(() => bed.dispose());

const callAudits = (records: ReadonlyArray<Record<string, unknown>>) =>
  records
    .filter((r) => r.type === "audit")
    .map((r) => r.entry as Record<string, unknown>)
    .filter((entry) => entry.kind === "call");

async function promptAndSettle(message: string): Promise<void> {
  const host = bed.host();
  const from = host.records.length;
  host.send({ type: "prompt", id: `p${from}`, message });
  await host.waitFor((r) => r.type === "agent_settled", { ...WORKER, from });
}

describe("pi-host worker: fail closed on bad rules", () => {
  it("blocks every call after a malformed policy update, says why in the audit, and recovers on the next valid one", async () => {
    await bed.start({ steps: [READ_A, { text: "1" }, READ_A, { text: "2" }] });
    const host = bed.host();
    // An unknown approval mode: the update does not parse, so the worker has no rules at all.
    host.send({ type: "policy_update", rules: { profile: "interactive", approvalMode: "yolo" } });
    await promptAndSettle("read it");
    const blocked = callAudits(host.records);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ tool: "read", decision: "block", reason: "no valid policy rules" });
    const end = host.records.find((r) => r.type === "tool_execution_end" && r.toolCallId === "r");
    expect(end).toMatchObject({ isError: true });
    expect(toolText(end ?? { type: "none" })).not.toContain("hello");
    expect(host.records.filter((r) => r.type === "extension_error")).toEqual([
      {
        type: "extension_error",
        extensionPath: "<inline:pap-policy>",
        event: "policy_update",
        error: "invalid policy rules: every call is blocked until the next valid update",
      },
    ]);

    host.send({
      type: "policy_update",
      rules: { profile: "interactive", approvalMode: "auto-accept-edits" },
    });
    await promptAndSettle("read again");
    const all = callAudits(host.records);
    expect(all.map((entry) => entry.decision)).toEqual(["block", "allow"]);
    const second = host.records.filter((r) => r.type === "tool_execution_end").at(-1);
    expect(second).toMatchObject({ isError: false });
    expect(toolText(second ?? { type: "none" })).toContain("hello");
  }, 90_000);

  it("refuses to start with invalid rules in its init, and never reports ready", async () => {
    const host = bed.launch(
      { steps: [{ text: "hi" }] },
      { policy: { profile: "interactive", approvalMode: "yolo" } },
    );
    expect(await host.exited).toBe(70);
    expect(host.stderr()).toContain("invalid policy rules");
    expect(host.records.some((r) => r.type === "ready")).toBe(false);
  }, 60_000);
});
