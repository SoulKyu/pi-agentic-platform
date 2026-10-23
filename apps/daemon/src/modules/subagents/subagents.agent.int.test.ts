import { afterEach, describe, expect, it, vi } from "vitest";
import { writeScript } from "../../security/testing/agent-bed.ts";
import { rows } from "../../security/testing/automation-bed.ts";
import { markOf, waitIdle } from "../../security/testing/fixtures.ts";
import { startVmBed, type VmBed } from "../../testing/vm-bed.ts";

// Task 29b's phase D on an agent in a VM (the process backend): the child of an agent thread keeps the agent, so its runs
// count in the agent's budget. What the child holds of the vault is the vault suite's (the vault reaches the VM in A4).
const CHILD_TEXT = "CHILD-ANSWER-7f3a";
const subagent = (task: string, id: string) => ({ toolCalls: [{ name: "subagent", args: { task }, id }] });

let bed: VmBed | undefined;
afterEach(async () => {
  await bed?.stop();
  bed = undefined;
});

const runsOf = (b: VmBed, parentId: string) =>
  rows<{ state: string; child_session_id: string | null }>(
    b.t.home,
    "SELECT state, child_session_id FROM subagent_runs WHERE parent_session_id = ? ORDER BY started_at, id",
    parentId,
  );
const sessionRow = (b: VmBed, id: string) =>
  rows<{ parent_session_id: string | null; agent_id: string | null; agent_role: string | null }>(
    b.t.home,
    "SELECT parent_session_id, agent_id, agent_role FROM sessions WHERE id = ?",
    id,
  )[0];
const childRuns = (b: VmBed, id: string) =>
  rows<{ origin: string; parent_session_id: string | null; agent_id: string | null }>(
    b.t.home,
    "SELECT origin, parent_session_id, agent_id FROM runs WHERE session_id = ? ORDER BY started_at",
    id,
  );

describe("a child of an agent thread in a VM (RT-07, M11R136)", () => {
  it("keeps the agent, so its runs count in the agent's budget, and runs in the thread's VM", async () => {
    bed = await startVmBed({ steps: [subagent("Check the board", "sa3"), { text: "Checked." }] });
    const agentId = await bed.createAgent({ preset: "read-only", mode: "read-only" });
    const thread = await bed.openThread(agentId);
    // The thread's worker has read its script: the next worker to start is the child's.
    writeScript(bed.t, { steps: [{ text: CHILD_TEXT }] });
    const mark = markOf(bed.owner.client);
    await bed.call("sessions.prompt", { sessionId: thread, text: "Check the board." });
    await waitIdle(bed.owner.client, mark);

    const [run] = runsOf(bed, thread);
    expect(run).toMatchObject({ state: "done" });
    const child = run?.child_session_id ?? "";
    expect(sessionRow(bed, child)).toMatchObject({
      parent_session_id: thread,
      agent_id: agentId,
      agent_role: "child",
    });
    await vi.waitFor(() => expect(childRuns(bed as VmBed, child)).toHaveLength(1), { timeout: 20_000 });
    expect(childRuns(bed, child)[0]).toMatchObject({
      origin: "subagent",
      agent_id: agentId,
      parent_session_id: thread,
    });
    expect(bed.vms.started).toHaveLength(1);
  }, 120_000);
});
