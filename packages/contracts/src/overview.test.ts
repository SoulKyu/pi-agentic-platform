import { describe, expect, it } from "vitest";
import { AccountAppearance } from "./settings.ts";
import { methods } from "./methods.ts";
import { OverviewAsk, OverviewBox, OverviewSnapshot } from "./overview.ts";

const item = {
  id: "i1",
  kind: "agent_approve",
  toHandle: true,
  taskId: null,
  sessionId: null,
  triggerName: "deploy",
  costUsd: null,
  createdAt: 1,
  readAt: null,
  resolvedAt: null,
  resolution: null,
};
const box = {
  ref: { kind: "project", id: "p1" },
  name: "site",
  state: "waiting",
  phase: "running",
  activities: [{ kind: "task", id: "t1", title: "build", since: 5, stoppable: true }],
  more: 0,
  ask: { source: "inbox", item },
  costUsd: 0.5,
  apiEquivalent: false,
  reservedMb: 1536,
  needMb: 1536,
  fits: true,
  busy: true,
  alwaysOn: false,
  nextRun: { at: 9, name: "nightly" },
};
const owner = {
  capacity: {
    role: "owner",
    memory: { usedMb: 3072, maxMb: 4096, full: false },
    workers: { used: 1, max: 4 },
    cost: { totalUsd: 1, membersUsd: 0.25, apiEquivalent: true },
    failures: 0,
  },
  boxes: [box],
  members: [{ userId: "u2", name: "Ana", activeBoxes: 1, reservedMb: 1024, costUsd: 0.25, budgetUsd: null }],
  vmUsable: true,
};
const member = {
  capacity: { role: "member", sharedPercent: 45, yourMb: 1024, cost: { usd: 0.1, budgetUsd: 5 } },
  boxes: [{ ...box, phase: null, needMb: 0 }],
  members: [],
  vmUsable: true,
};

describe("the Overview snapshot", () => {
  it("parses a full owner and a full member snapshot", () => {
    expect(OverviewSnapshot.safeParse(owner).success).toBe(true);
    expect(OverviewSnapshot.safeParse(member).success).toBe(true);
  });

  it("requires alwaysOn on a box", () => {
    expect(OverviewBox.safeParse({ ...box, alwaysOn: undefined }).success).toBe(false);
    expect(OverviewBox.safeParse({ ...box, alwaysOn: true }).success).toBe(true);
  });

  it("refuses four activities, a percentage over 100 and an unknown ask source", () => {
    const four = { ...box, activities: Array.from({ length: 4 }, () => box.activities[0]) };
    expect(OverviewBox.safeParse(four).success).toBe(false);
    const cap = { ...member.capacity, sharedPercent: 101 };
    expect(OverviewSnapshot.safeParse({ ...member, capacity: cap }).success).toBe(false);
    expect(OverviewAsk.safeParse({ source: "mail" }).success).toBe(false);
  });
});

describe("the Overview methods", () => {
  it("are in the catalogue with their permissions", () => {
    expect(methods["overview.get"]).toMatchObject({ permission: "sessions:read", idempotent: true });
    expect(methods["subscribe.overview"]).toMatchObject({ permission: "sessions:read" });
    expect(methods["projects.stopBox"]).toMatchObject({ permission: "sessions:operate", idempotent: false });
    expect(methods["agents.stopBox"]).toMatchObject({ permission: "agents:admin", idempotent: false });
  });
});

describe("the Open on setting", () => {
  it("defaults to home and refuses another place", () => {
    expect(AccountAppearance.parse({}).openOn).toBe("home");
    expect(AccountAppearance.safeParse({ openOn: "elsewhere" }).success).toBe(false);
  });
});
