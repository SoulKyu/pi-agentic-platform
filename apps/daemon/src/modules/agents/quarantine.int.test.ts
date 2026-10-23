import { afterEach, describe, expect, it } from "vitest";
import { rows } from "../../security/testing/automation-bed.ts";
import { startVmBed, type VmBed } from "../../testing/vm-bed.ts";

// The real sessions module on a real worker (the process-backend VM): the archive that quarantine runs ends the agent's
// thread. What the archive does to the thread's host grants and one-use values is the unit tests' (host-grants, quarantine).
let bed: VmBed | undefined;
afterEach(async () => {
  await bed?.stop();
  bed = undefined;
});

describe("quarantine over a real thread session (W5-R52)", () => {
  it("leaves the thread archived and the agent quarantined, without its thread", async () => {
    bed = await startVmBed({ steps: [{ text: "placeholder" }] });
    const agentId = await bed.createAgent({ name: "Atlas" });
    const sessionId = await bed.openThread(agentId);
    const archivedAt = () =>
      rows<{ archived_at: number | null }>(
        (bed as VmBed).t.home,
        "SELECT archived_at FROM sessions WHERE id = ?",
        sessionId,
      )[0]?.archived_at;
    expect(archivedAt()).toBeNull();

    await bed.call("agents.quarantine", { agentId });

    expect(archivedAt()).not.toBeNull();
    const view = await bed.call<{ state: string; threadSessionId: string | null }>("agents.get", { agentId });
    expect(view).toMatchObject({ state: "quarantined", threadSessionId: null });
  }, 120_000);
});
