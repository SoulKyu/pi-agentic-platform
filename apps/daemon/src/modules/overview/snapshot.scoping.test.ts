import type { OverviewMemberLine } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import {
  agent,
  build,
  FULL_SCOPE,
  item,
  member,
  MEMBER,
  OWNER,
  project,
  session,
  task,
} from "./snapshot-bed.ts";

describe("owner view: member lines (Review Focus 1)", () => {
  it("holds the six fields only, by name, never a disabled member", () => {
    const secret = "salary-review";
    const { snapshot } = build({
      users: [
        member({
          id: "member-z",
          username: "zed",
          spentTodayUsd: 0.4,
          budgetUsd: 5,
          boxes: [
            { kind: "project", id: "pz" },
            { kind: "agent", id: "az" },
          ],
          // facts a careless spread would carry along
          ...({ secretName: secret, projectNames: [secret] } as object),
        }),
        member({ id: "member-a", username: "amy", boxes: [{ kind: "project", id: "pa" }] }),
        member({ id: "member-off", username: "off", disabled: true }),
      ],
      phases: { "project:pz": "running", "agent:az": "stopped", "project:pa": "stopped" },
      reserved: { "project:pz": 1536, "agent:az": 0, "project:pa": 0 },
    });
    const view = snapshot(OWNER, true);
    const lines: OverviewMemberLine[] = view.members;
    expect(lines).toEqual([
      { userId: "member-a", name: "amy", activeBoxes: 0, reservedMb: 0, costUsd: 0, budgetUsd: 5 },
      { userId: "member-z", name: "zed", activeBoxes: 1, reservedMb: 1536, costUsd: 0.4, budgetUsd: 5 },
    ]);
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual(
      ["activeBoxes", "budgetUsd", "costUsd", "name", "reservedMb", "userId"].sort(),
    );
    expect(JSON.stringify(view)).not.toContain(secret);
  });

  it("never reads a member's boxes, sessions, tasks or items for the owner's cards", () => {
    const { snapshot, spendCalls } = build({
      agents: { [OWNER]: [agent("agent-o", "idle")], [MEMBER]: [agent("agent-m", "needs_input")] },
      projects: { [MEMBER]: [project("proj-member", "box", { name: "secret-project" })] },
      sessions: {
        [MEMBER]: [session({ id: "sm", projectId: "proj-member", name: "salary-review", status: "running" })],
      },
      tasks: {
        [MEMBER]: [
          task({ id: "tm", projectId: "proj-member", title: "quarterly-numbers" }),
          // rows of the member that carry the owner's own agent id: a read of the wrong owner would show them on its card
          task({ id: "tm2", agentId: "agent-o", title: "quarterly-numbers-2" }),
        ],
      },
      pending: {
        [MEMBER]: [item({ id: "im", agentId: "agent-m" }), item({ id: "im2", agentId: "agent-o" })],
      },
      users: [member({ id: MEMBER, username: "mia", boxes: [{ kind: "project", id: "proj-member" }] })],
    });
    const view = snapshot(OWNER, true);
    expect(view.boxes.map((one) => [one.ref.id, one.state, one.activities, one.ask])).toEqual([
      ["agent-o", "stopped", [], null],
    ]);
    const text = JSON.stringify(view);
    for (const leak of [
      "secret-project",
      "salary-review",
      "quarterly-numbers",
      "agent-m",
      "proj-member",
      "agent_approve",
      "tm2",
      "im2",
    ])
      expect(text).not.toContain(leak);
    expect(spendCalls).toEqual([{ ownerId: OWNER, apiOnly: false }]);
  });
});

describe("member view (Review Focus 2)", () => {
  it("shows a member their own boxes only, no member lines, a percentage and their own cost", () => {
    const { snapshot, spendCalls } = build({
      memory: { usedMb: 8000, maxMb: 10_240 },
      agents: {
        [MEMBER]: [agent("agent-m", "running")],
        [OWNER]: [agent("agent-o", "needs_input", { name: "owners-private-agent" })],
      },
      projects: { [OWNER]: [project("proj-owner", "box", { name: "owners-private-project" })] },
      sessions: {
        [OWNER]: [session({ id: "so", projectId: "proj-owner", name: "owners-session", status: "running" })],
      },
      tasks: { [OWNER]: [task({ id: "to", agentId: "agent-m", title: "owners-task" })] },
      threads: {
        [OWNER]: {
          "thread-agent-m": {
            running: true,
            starting: false,
            needsInput: true,
            name: "owners-session-with-the-members-id",
          },
        },
      },
      pending: {
        [OWNER]: [
          item({ id: "io", agentId: "agent-o" }),
          item({ id: "io2", agentId: "agent-m", detail: "owners-approval" }),
        ],
      },
      reserved: { "agent:agent-m": 1536 },
      phases: { "agent:agent-m": "running" },
      users: [
        member({
          id: MEMBER,
          username: "mia",
          spentTodayUsd: 1.5,
          budgetUsd: 5,
          boxes: [{ kind: "agent", id: "agent-m" }],
        }),
      ],
      spend: { totalUsd: 9, agents: { "agent-m": 1.5 } },
    });
    const view = snapshot(MEMBER, true);
    expect(view.members).toEqual([]);
    expect(view.boxes.map((one) => [one.ref.id, one.ask])).toEqual([["agent-m", null]]);
    expect(view.capacity).toEqual({
      role: "member",
      sharedPercent: 80,
      yourMb: 1536,
      cost: { usd: 1.5, budgetUsd: 5 },
    });
    const text = JSON.stringify(view);
    for (const leak of [
      "owners-",
      "owner-1",
      "agent-o",
      "proj-owner",
      "usedMb",
      "maxMb",
      "workers",
      "failures",
      "10240",
      "8000",
    ])
      expect(text).not.toContain(leak);
    expect(spendCalls).toEqual([{ ownerId: MEMBER, apiOnly: true }]);
  });

  it("rounds the shared percentage to a multiple of 5 and reads it null when the VM stack is unusable", () => {
    const rounded = build({ memory: { usedMb: 1111, maxMb: 10_240 }, users: [member({ id: MEMBER })] });
    expect(rounded.snapshot(MEMBER, true).capacity).toMatchObject({ sharedPercent: 10 });
    expect(rounded.snapshot(MEMBER, false).capacity).toMatchObject({ sharedPercent: null });
    expect(rounded.snapshot(MEMBER, false).vmUsable).toBe(false);
  });

  it("treats an unknown id like a member: nothing of anybody else", () => {
    const { snapshot } = build({
      agents: { [OWNER]: [agent("agent-o", "idle")] },
      users: [member({ id: MEMBER })],
    });
    const view = snapshot("stranger", true);
    expect(view.boxes).toEqual([]);
    expect(view.members).toEqual([]);
    expect(view.capacity).toEqual({
      role: "member",
      sharedPercent: 30,
      yourMb: 0,
      cost: { usd: 0, budgetUsd: null },
    });
  });
});

describe("the credential's scope on the owner's view", () => {
  const world = {
    users: [member({ id: MEMBER, username: "mia", spentTodayUsd: 0.4 })],
  };

  it("gives the member lines only to a caller holding users:read", () => {
    const { snapshot } = build(world);
    expect(snapshot(OWNER, true, { members: true, failures: false }).members).toHaveLength(1);
    const without = snapshot(OWNER, true, { members: false, failures: true });
    expect(without.members).toEqual([]);
    expect(JSON.stringify(without)).not.toContain("mia");
  });

  it("gives the failure count only to a caller holding pi:admin", () => {
    const { snapshot } = build(world);
    expect(snapshot(OWNER, true, { members: false, failures: true }).capacity).toMatchObject({ failures: 3 });
    expect(snapshot(OWNER, true, { members: true, failures: false }).capacity).toMatchObject({
      failures: null,
    });
  });

  it("never gives a member either, whatever the permissions say", () => {
    const { snapshot } = build({ ...world, memory: { usedMb: 0, maxMb: 4096 } });
    const view = snapshot(MEMBER, true, FULL_SCOPE);
    expect(view.members).toEqual([]);
    expect(view.capacity).not.toHaveProperty("failures");
  });
});
