import { afterEach, describe, expect, it, vi } from "vitest";
import { bash } from "./security/testing/agent-bed.ts";
import { markOf } from "./security/testing/fixtures.ts";
import { type BoxBed, startBoxBed } from "./testing/box-bed.ts";
import { addMember, codeOf } from "./testing/two-users.ts";

// STOP of the Overview (R6) on the process backend: `projects.stopBox` and `agents.stopBox`, asked over RPC like the web does.

let bed: BoxBed | undefined;
afterEach(async () => {
  await bed?.stop();
  bed = undefined;
});

const phaseOf = async (b: BoxBed, projectId: string): Promise<string> =>
  (await b.call<{ box: { phase: string } }>("projects.box", { projectId })).box.phase;

describe("STOP of a project's box", () => {
  it("stops a running box, and a start and a stop sent at once leave it stopped with no live entry", async () => {
    const b = (bed = await startBoxBed({ steps: [] }));
    const project = await b.createProject("Stoppable");
    await b.startBox(project.id);
    expect(await phaseOf(b, project.id)).toBe("running");
    expect(await b.call("projects.stopBox", { projectId: project.id })).toEqual({ ok: true });
    expect(await phaseOf(b, project.id)).toBe("stopped");

    const [started, stopped] = await Promise.all([
      b.owner.client.call("projects.startBox", { projectId: project.id }),
      b.owner.client.call("projects.stopBox", { projectId: project.id }),
    ]);
    expect(codeOf(started)).toBe("ok");
    expect(codeOf(stopped)).toBe("ok");
    expect(await phaseOf(b, project.id)).toBe("stopped");
    expect(b.vm.runtime.liveVms({ kind: "project", id: project.id })).toBe(0);
  }, 180_000);

  it("answers not_found to a member for the owner's project", async () => {
    const b = (bed = await startBoxBed({ steps: [] }));
    const project = await b.createProject("Owners");
    await b.startBox(project.id);
    const member = await addMember(b);
    try {
      expect(codeOf(await member.call("projects.stopBox", { projectId: project.id }))).toBe("not_found");
      expect(await phaseOf(b, project.id)).toBe("running");
    } finally {
      member.client.close();
    }
  }, 180_000);
});

describe("STOP of an agent's box", () => {
  it("interrupts a running thread and stops the VM; a token caller is forbidden", async () => {
    const b = (bed = await startBoxBed({
      steps: [bash("sleep 120", "s1"), { text: "late" }],
    }));
    const agentId = await b.createAgent({ name: "Sleeper" });
    const sessionId = await b.openThread(agentId);
    const mark = markOf(b.owner.client);
    await b.call("sessions.prompt", { sessionId, text: "sleep" });
    await b.owner.client.waitForEvent(
      (f) => (f.event as { status?: string }).status === "running" && f.seq > mark,
    );
    const statusOf = async (): Promise<string | undefined> =>
      (await b.call<{ agents: Array<{ id: string; phase: string }> }>("agents.vmStatus", {})).agents.find(
        (agent) => agent.id === agentId,
      )?.phase;
    expect(await statusOf()).toBe("running");

    const minted = await b.call<{ value: string }>("auth.tokens.create", {
      name: "ci",
      permissions: ["sessions:read", "sessions:operate"],
      expiresInDays: 7,
    });
    const bot = await b.t.connectBearer(minted.value);
    try {
      expect(codeOf(await bot.call("agents.stopBox", { agentId } as never))).toBe("forbidden");
    } finally {
      bot.close();
    }

    const sessionStatus = async (): Promise<string | undefined> =>
      (await b.call<{ sessions: Array<{ id: string; status: string }> }>("sessions.list", {})).sessions.find(
        (session) => session.id === sessionId,
      )?.status;
    expect(await sessionStatus()).toBe("running");

    expect(await b.call("agents.stopBox", { agentId })).toEqual({ ok: true });
    await vi.waitFor(async () => expect(await sessionStatus()).not.toBe("running"), { timeout: 30_000 });
    expect(await statusOf()).toBe("stopped");
    expect(b.vms.stopped.some((entry) => entry.agentId === agentId)).toBe(true);
    // Stopping a stopped agent is fine, and an unknown one is not_found.
    expect(await b.call("agents.stopBox", { agentId })).toEqual({ ok: true });
    expect(codeOf(await b.owner.client.call("agents.stopBox", { agentId: "nobody-0001" }))).toBe("not_found");
  }, 180_000);
});
