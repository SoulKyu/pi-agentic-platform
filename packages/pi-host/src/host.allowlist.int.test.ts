import { PolicyRules } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_ALLOWLISTED } from "./policy/tool-allowlist.ts";
import { createHostBed as makeBed, isApproval, isCallAudit } from "./testing/host-bed.ts";

const within = { timeout: 20_000 };
const rules = (extra: object = {}) =>
  PolicyRules.parse({
    profile: "interactive",
    approvalMode: "auto-accept-edits",
    readOnlyCommands: false,
    unattended: true,
    toolAllowlist: ["read"],
    ...extra,
  });
const bashStep = (command: string, id: string) => ({ toolCalls: [{ name: "bash", args: { command }, id }] });
const script = {
  steps: [
    bashStep("echo one", "b1"),
    { text: "1" },
    bashStep("echo two", "b2"),
    { text: "2" },
    bashStep("echo three", "b3"),
    { text: "3" },
  ],
};

describe("pi-host worker: the pinned tool allowlist (M10R28)", () => {
  let bed: ReturnType<typeof makeBed>;
  beforeEach(() => {
    bed = makeBed();
  });
  afterEach(() => bed.dispose());

  async function open(allowlist: string[]) {
    await bed.start(script, {
      init: { tools: { preset: allowlist.includes("bash") ? "full" : "read-only", allowlist } },
      policy: rules({ toolAllowlist: allowlist }),
    });
    const host = bed.host();
    await host.waitFor((record) => record.type === "loadout");
    return host;
  }
  type Host = ReturnType<typeof bed.host>;
  const toolsOf = (host: Host) =>
    host.records
      .filter((r) => r.type === "loadout")
      .map((r) => (r.loadout as { tools: string[] }).tools)
      .at(-1);
  const ends = (host: Host) => host.records.filter((r) => r.type === "tool_execution_end");
  const blockAudits = (host: Host) =>
    host.records.filter(isCallAudit).filter((r) => (r.entry as { decision?: string }).decision === "block");

  async function runOnce(host: Host, id: string, ended: number) {
    host.send({ type: "prompt", id, message: "go" });
    await vi.waitFor(() => expect(ends(host)).toHaveLength(ended), within);
  }

  it("shows the model only the listed tools, so a scripted bash call never runs, whatever policy_update says", async () => {
    const host = await open(["read"]);
    expect(toolsOf(host)).toEqual(["read"]);
    await runOnce(host, "p1", 1);
    host.send({ type: "policy_update", rules: rules({ toolAllowlist: null }) });
    await runOnce(host, "p2", 2);
    host.send({ type: "policy_update", rules: rules({ toolAllowlist: ["read", "bash"] }) });
    await runOnce(host, "p3", 3);
    expect(toolsOf(host)).toEqual(["read"]);
    expect(ends(host).every((r) => r.isError === true)).toBe(true);
    expect(JSON.stringify(ends(host))).not.toMatch(/one|two|three/);
  }, 90_000);

  it("blocks by name at stage 02 when a policy_update narrows the pinned list, and never widens it", async () => {
    const host = await open(["read", "bash"]);
    expect(toolsOf(host)).toEqual(expect.arrayContaining(["read", "bash"]));
    host.send({ type: "policy_update", rules: rules({ toolAllowlist: ["read"] }) });
    await runOnce(host, "p1", 1);
    expect(blockAudits(host)[0]).toMatchObject({ entry: { tool: "bash", reason: NOT_ALLOWLISTED } });
    expect(ends(host)[0]).toMatchObject({ isError: true });
    host.send({ type: "policy_update", rules: rules({ toolAllowlist: ["read", "bash", "write"] }) });
    host.send({ type: "prompt", id: "p2", message: "go" });
    // Past stage 02 the matrix decides: bash asks, while "write" (outside the pin) was never reachable.
    const ask = await host.waitFor(isApproval);
    expect(ask).toMatchObject({ tool: "bash" });
    host.send({ type: "approval_response", id: ask.id, answer: "deny" });
    await vi.waitFor(() => expect(host.records.filter(isCallAudit)).toHaveLength(2), within);
    expect(blockAudits(host)).toHaveLength(1);
  }, 90_000);

  it("refuses an init whose allowlist holds an invalid name", async () => {
    const host = bed.launch(script, { init: { tools: { preset: "read-only", allowlist: ["-x"] } } });
    expect(await host.exited).toBe(70);
    expect(host.records.some((r) => r.type === "ready")).toBe(false);
  }, 60_000);
});
