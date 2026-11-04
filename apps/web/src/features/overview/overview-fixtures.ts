import type { OverviewBox, OverviewSnapshot } from "@pap/contracts";

export const NOW = Date.UTC(2026, 10, 3, 12, 0);

export const box = (patch: Partial<OverviewBox> = {}): OverviewBox => ({
  ref: { kind: "agent", id: "atlas-1a2b" },
  name: "Atlas",
  state: "running",
  phase: "running",
  activities: [],
  more: 0,
  ask: null,
  costUsd: 0.4,
  apiEquivalent: false,
  reservedMb: 1536,
  needMb: 1536,
  fits: true,
  busy: false,
  alwaysOn: false,
  nextRun: null,
  ...patch,
});

export const ownerSnapshot = (patch: Partial<OverviewSnapshot> = {}): OverviewSnapshot => ({
  capacity: {
    role: "owner",
    memory: { usedMb: 8192, maxMb: 10240, full: false },
    workers: { used: 4, max: 6 },
    cost: { totalUsd: 1.84, membersUsd: 0.27, apiEquivalent: false },
    failures: null,
  },
  boxes: [box()],
  members: [],
  vmUsable: true,
  ...patch,
});

export const memberSnapshot = (patch: Partial<OverviewSnapshot> = {}): OverviewSnapshot => ({
  capacity: { role: "member", sharedPercent: 80, yourMb: 1536, cost: { usd: 0.5, budgetUsd: 2 } },
  boxes: [box()],
  members: [],
  vmUsable: true,
  ...patch,
});
