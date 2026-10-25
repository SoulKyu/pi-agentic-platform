import { DEFAULT_PROJECT_RESOURCES } from "@pap/contracts";
import { vi } from "vitest";
import { type AgentsVmLate, bindAgentsVmLate } from "../compose-agents-vm-late.ts";
import { createFakeClock } from "../kernel/clock.ts";
import { silentLogger } from "../kernel/logger.ts";
import type { ProjectBoxRow } from "../kernel/boxes.ts";
import { createFakeProjectBoxSource } from "../kernel/testing/fake-boxes.ts";
import { sharesAllProviders } from "./shares-all.ts";

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
    /** The Claude token of each owner (M14); replaces `token`. */
    tokens?: Record<string, string>;
    overBudget?: (ownerId: string) => boolean;
    /** The providers gate (M14); everything is shared by default. */
    providers?: AgentsVmLate["providers"];
    /** The member line (M14); nobody is over by default. */
    memberLine?: AgentsVmLate["memberLine"];
    /** The runs port the policy follows (default: none ends); and the relay it pushes to (default: no relay). */
    runs?: AgentsVmLate["runs"]["port"];
    relay?: { refresh: (box: unknown) => void; refreshAll: () => void };
    cwdOf?: (ownerId: string, sessionId: string) => string | null;
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
    providers: over.providers ?? sharesAllProviders,
    memberLine: over.memberLine ?? { over: () => false, disabled: () => false },
    sessions: {
      mirror: { notice: () => {}, taint: () => {} },
      kindOf: () => null,
      ...(over.cwdOf ? { cwdOf: over.cwdOf } : {}),
    },
    pi: {
      plugins: { sourcesOf: async () => null, check: async () => {} },
      models: { available, onChanged: () => {} },
    },
    agents: { list: () => [], ownerOf: () => null, get: () => null, onChange: () => () => {} },
    runs: { port: over.runs ?? { onLiveCost: () => () => {}, onRunEnd: () => () => {} } },
    automation: { agentTasks: { overBudget: () => false, ownerOverBudget } },
    ...(over.ownerHosts ? { ownerHosts: over.ownerHosts } : {}),
    boxes: { source: createFakeProjectBoxSource(over.rows ?? { [PROJECT]: boxRow() }) },
  } as unknown as AgentsVmLate;
  const derived = bindAgentsVmLate(
    {
      clock: createFakeClock(),
      logger: silentLogger,
      closers: [],
      relay: (over.relay ?? null) as never,
      claudeToken: {
        get: (ownerId: string) =>
          over.tokens ? (over.tokens[ownerId] ?? null) : over.token ? "tok-x" : null,
      },
      readOnly: false,
      bindMirrorHooks: () => {},
      bindTaint: () => {},
    },
    late,
  );
  return { derived, available, ownerOverBudget };
}
