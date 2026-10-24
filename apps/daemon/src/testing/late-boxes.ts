import { DEFAULT_PROJECT_RESOURCES } from "@pap/contracts";
import { vi } from "vitest";
import { type AgentsVmLate, bindAgentsVmLate } from "../compose-agents-vm-late.ts";
import { createFakeClock } from "../kernel/clock.ts";
import { silentLogger } from "../kernel/logger.ts";
import type { ProjectBoxRow } from "../kernel/boxes.ts";
import { createFakeProjectBoxSource } from "../kernel/testing/fake-boxes.ts";

export const PROJECT = "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11";

export const boxRow = (extra: Partial<ProjectBoxRow> = {}): ProjectBoxRow => ({
  ownerId: "u1",
  root: `/boxes/${PROJECT}`,
  resources: DEFAULT_PROJECT_RESOURCES,
  hosts: [],
  deleting: false,
  ...extra,
});

/** The late binding of the VM composition with project boxes only: no agent exists. Its derived views are what the relay and the proxy read. */
export function lateWithBoxes(
  over: {
    rows?: Record<string, ProjectBoxRow>;
    ownerHosts?: (ownerId: string) => readonly string[] | null;
    models?: Array<{ provider: string; id: string }>;
    token?: boolean;
    overBudget?: (ownerId: string) => boolean;
  } = {},
) {
  const available = vi.fn(async () => ({
    models: (over.models ?? [{ provider: "acme", id: "m-1" }]).map((m) => ({
      ...m,
      name: m.id,
      reasoning: false,
    })),
    providers: [],
    origin: "signed-in" as const,
    truncated: false,
  }));
  const ownerOverBudget = vi.fn(over.overBudget ?? (() => false));
  const late = {
    sessions: { mirror: { notice: () => {}, taint: () => {} }, kindOf: () => null },
    pi: {
      plugins: { sourcesOf: async () => null, check: async () => {} },
      models: { available, onChanged: () => {} },
    },
    agents: { list: () => [], ownerOf: () => null, get: () => null, onChange: () => () => {} },
    runs: { port: { onLiveCost: () => () => {}, onRunEnd: () => () => {} } },
    automation: { agentTasks: { overBudget: () => false, ownerOverBudget } },
    ...(over.ownerHosts ? { ownerHosts: over.ownerHosts } : {}),
    boxes: { source: createFakeProjectBoxSource(over.rows ?? { [PROJECT]: boxRow() }) },
  } as unknown as AgentsVmLate;
  const derived = bindAgentsVmLate(
    {
      clock: createFakeClock(),
      logger: silentLogger,
      closers: [],
      relay: null,
      claudeToken: { status: () => (over.token ? "set" : "missing") },
      readOnly: false,
      bindMirrorHooks: () => {},
      bindTaint: () => {},
    },
    late,
  );
  return { derived, available, ownerOverBudget };
}
