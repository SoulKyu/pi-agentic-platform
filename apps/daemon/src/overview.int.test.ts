import { OverviewSnapshot, type ProjectView, TriggerInput } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bash } from "./security/testing/agent-bed.ts";
import { createTrigger } from "./security/testing/automation-bed.ts";
import { markOf } from "./security/testing/fixtures.ts";
import { type BoxBed, startBoxBed } from "./testing/box-bed.ts";
import { addMember, codeOf, ownerOf, type Person, writeDb } from "./testing/two-users.ts";

// The Overview's scoping (Review Focus 1 and 2) on the process backend, with two users. The member owns a project, a running
// session, a running task and a pending approval, every one named by a string that must never reach the owner's snapshot.
const SECRET = {
  project: "secret-project",
  session: "salary-review",
  task: "quarterly-numbers",
  approval: "secret-approval",
} as const;
const OWNER_OWN = { project: "owner-private-project", agent: "owner-private-agent" } as const;

let bed: BoxBed;
let owner: Person;
let member: Person;
let memberProject: ProjectView;
let memberSessionId: string;
let ownerAgentId: string;
let ownerProjectId: string;
let ownerThreadId: string;

const snapshotOf = async (who: Person): Promise<OverviewSnapshot> => {
  const frame = await who.client.call("overview.get", {});
  if (!frame.ok) throw new Error(`overview.get: ${frame.error.code}`);
  return OverviewSnapshot.parse(frame.result);
};

beforeAll(async () => {
  bed = await startBoxBed({
    steps: [bash("sleep 120", "s1"), bash("sleep 120", "s2"), bash("sleep 120", "s3")],
  });
  owner = await ownerOf(bed);
  member = await addMember(bed, "mia");
  const ownerProject = await bed.createProject(OWNER_OWN.project);
  ownerProjectId = ownerProject.id;
  await bed.startBox(ownerProject.id);
  ownerAgentId = await bed.createAgent({ name: OWNER_OWN.agent });

  const created = await member.call("projects.create", { name: SECRET.project });
  if (!created.ok) throw new Error("member project");
  memberProject = (created.result as { project: ProjectView }).project;
  await member.call("projects.startBox", { projectId: memberProject.id });
  const opened = await member.call("sessions.create", { cwd: memberProject.root });
  if (!opened.ok) throw new Error("member session");
  memberSessionId = (opened.result as { sessionId: string }).sessionId;
  await member.call("sessions.rename", { sessionId: memberSessionId, name: SECRET.session });
  await member.call("subscribe.session", { sessionId: memberSessionId });
  await member.call("sessions.prompt", { sessionId: memberSessionId, text: "go" });
  await vi.waitFor(
    async () => {
      const mine = await snapshotOf(member);
      expect(
        mine.boxes.find((box) => box.ref.id === memberProject.id)?.activities.map((a) => a.kind),
      ).toEqual(["session"]);
    },
    { timeout: 60_000 },
  );
  const trigger = await createTrigger(
    member.client,
    TriggerInput.parse({
      name: SECRET.task,
      source: { type: "manual" },
      execution: { cwd: memberProject.root, tools: ["read", "bash"] },
      prompt: "Write the numbers.",
    }),
  );
  const fired = await member.call("automation.fire", { triggerId: trigger.id });
  if (!fired.ok) throw new Error("member task");
  await vi.waitFor(
    async () => {
      const mine = await snapshotOf(member);
      const kinds = mine.boxes.find((box) => box.ref.id === memberProject.id)?.activities.map((a) => a.kind);
      expect(kinds?.slice().sort()).toEqual(["session", "task"]);
    },
    { timeout: 60_000 },
  );
  // The owner's agent thread runs the third scripted step: its card must show the thread (R4, spec 3.5).
  ownerThreadId = await bed.openThread(ownerAgentId);
  await bed.call("sessions.prompt", { sessionId: ownerThreadId, text: "go" });
  writeDb(
    bed.t.home,
    "INSERT INTO inbox_items (id, owner_id, kind, to_handle, session_id, title, created_at) VALUES (?, ?, 'agent_approve', 1, ?, ?, ?)",
    "approval-secret-0001",
    member.id,
    memberSessionId,
    SECRET.approval,
    Date.now(),
  );
}, 240_000);
afterAll(async () => {
  member?.client.close();
  await bed?.stop();
});

describe("the owner's snapshot holds no member content (Review Focus 1)", () => {
  it("names nothing the member owns, and the member's id only in its usage line", async () => {
    const view = await snapshotOf(owner);
    const text = JSON.stringify(view);
    for (const secret of Object.values(SECRET)) expect(text, secret).not.toContain(secret);
    for (const own of [
      memberProject.id,
      memberProject.root,
      memberSessionId,
      "agent_approve",
      "approval-secret",
    ])
      expect(text, own).not.toContain(own);
    expect(text.split(member.id)).toHaveLength(2);
    expect(view.members).toEqual([
      expect.objectContaining({
        userId: member.id,
        name: "mia",
        activeBoxes: 1,
        budgetUsd: expect.any(Number),
      }),
    ]);
    expect(Object.keys(view.members[0] ?? {}).sort()).toEqual(
      ["activeBoxes", "budgetUsd", "costUsd", "name", "reservedMb", "userId"].sort(),
    );
    expect(view.members[0]?.reservedMb).toBeGreaterThan(0);
  });

  it("shows the owner's running agent thread on its card, with its start, and marks the card busy", async () => {
    await vi.waitFor(
      async () => {
        const card = (await snapshotOf(owner)).boxes.find((box) => box.ref.id === ownerAgentId);
        expect(card?.activities.map((a) => a.kind)).toEqual(["thread"]);
      },
      { timeout: 60_000 },
    );
    const card = (await snapshotOf(owner)).boxes.find((box) => box.ref.id === ownerAgentId);
    expect(card).toMatchObject({ state: "running", busy: true });
    expect(card?.activities[0]).toMatchObject({ kind: "thread", id: ownerThreadId, stoppable: false });
    expect(card?.activities[0]?.since).toEqual(expect.any(Number));
  });

  it("shows the owner's own boxes, the memory the runtime reports and the workers", async () => {
    const view = await snapshotOf(owner);
    expect(view.boxes.map((box) => box.name)).toEqual(
      expect.arrayContaining([OWNER_OWN.project, OWNER_OWN.agent]),
    );
    const { usedMb, maxMb } = bed.vm.runtime.memory();
    expect(view.capacity).toMatchObject({
      role: "owner",
      memory: { usedMb, maxMb, full: false },
      workers: { max: expect.any(Number) },
    });
    expect(view.vmUsable).toBe(true);
  });
});

describe("a member's snapshot holds only their own boxes (Review Focus 2)", () => {
  it("shows their project with its running session, task and approval, and nothing of the owner", async () => {
    const view = await snapshotOf(member);
    const card = view.boxes.find((box) => box.ref.id === memberProject.id);
    expect(card).toMatchObject({ name: SECRET.project, state: "waiting", ref: { kind: "project" } });
    expect(card?.ask).toMatchObject({ source: "inbox", item: { id: "approval-secret-0001" } });
    expect(card?.activities.map((a) => a.kind).sort()).toEqual(["session", "task"]);
    const text = JSON.stringify(view);
    for (const foreign of [...Object.values(OWNER_OWN), owner.id, "usedMb", "maxMb", "workers", "failures"])
      expect(text, foreign).not.toContain(foreign);
    expect(view.boxes.every((box) => box.ref.id === memberProject.id)).toBe(true);
    expect(view.members).toEqual([]);
    expect(view.capacity.role).toBe("member");
    if (view.capacity.role !== "member") return;
    expect(view.capacity.sharedPercent).not.toBeNull();
    expect((view.capacity.sharedPercent ?? 1) % 5).toBe(0);
    expect(view.capacity.yourMb).toBeGreaterThan(0);
  });

  it("answers a token with sessions:read the same scoping, for the owner and for the member", async () => {
    const asMember = await bed.t.connectBearer(member.token);
    const asOwner = await bed.t.connectBearer(owner.token);
    try {
      const mine = await asMember.call("overview.get", {});
      const theirs = await asOwner.call("overview.get", {});
      expect(codeOf(mine)).toBe("ok");
      expect(codeOf(theirs)).toBe("ok");
      const memberView = OverviewSnapshot.parse((mine as { result: unknown }).result);
      const ownerView = OverviewSnapshot.parse((theirs as { result: unknown }).result);
      expect(memberView.capacity.role).toBe("member");
      expect(memberView.boxes.map((box) => box.name)).toEqual([SECRET.project]);
      expect(ownerView.capacity.role).toBe("owner");
      expect(JSON.stringify(ownerView)).not.toContain(SECRET.project);
      // This token holds sessions:read only: no member lines (users:read) and no failure count (pi:admin, R12).
      expect(ownerView.members).toEqual([]);
      expect(ownerView.capacity).toMatchObject({ failures: null });
      expect(JSON.stringify(ownerView)).not.toContain("mia");
    } finally {
      asMember.close();
      asOwner.close();
    }
  });
});

describe("the overview stream", () => {
  it("ticks a viewer after a box starts, and sends no payload", async () => {
    const subscribed = await owner.client.call("subscribe.overview", {});
    if (!subscribed.ok) throw new Error(`subscribe.overview: ${subscribed.error.code}`);
    const { sub } = subscribed.result as { sub: string };
    await owner.client.waitForEvent((frame) => frame.sub === sub);
    // The host is at its memory cap by now: free the owner's box first, then start it again.
    await bed.call("projects.stopBox", { projectId: ownerProjectId });
    await owner.client.waitForEvent((frame) => frame.sub === sub && frame.seq > 0);
    const mark = markOf(owner.client, sub);
    await bed.startBox(ownerProjectId);
    const tick = await owner.client.waitForEvent((frame) => frame.sub === sub && frame.seq > mark);
    expect(tick.event).toEqual({ kind: "changed" });
    const events = owner.client.events.filter((frame) => frame.sub === sub).map((frame) => frame.event);
    expect(events.every((event) => JSON.stringify(event) === '{"kind":"changed"}')).toBe(true);
  });
});
