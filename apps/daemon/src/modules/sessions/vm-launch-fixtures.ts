import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput, type InitRecord, PolicyRules, type VmLayout } from "@pap/contracts";
import { afterEach, beforeEach, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import type { ImageObserver, LaunchRegistry } from "../../kernel/launches.ts";
// eslint-disable-next-line no-restricted-imports -- fixtures of the launch tests only, imported by test files alone
import { createFakeWorker } from "../../kernel/testing/fake-worker.ts";
import { layoutOf, type VmSpec } from "../agent-vm/index.ts";
import type { AgentLaunch } from "./agent-gate.ts";
import { createAgentRules } from "./agent-rules.ts";
import type { SessionRow } from "./store.ts";
import { createVmLaunch } from "./vm-launch.ts";

export const ID = "atlas-1a2b";
export const TASK = "0f6c0f2e-1111-4222-8333-444455556666";
export const KEY = "a".repeat(32);
export const SLOT = "b".repeat(32);
export const IMAGE = `pap-agent-agent-${"c".repeat(64)}`;
let home: string;
export const homeDir = (): string => home;
/** Call once at the top of a test file: a fresh `$PAP_HOME` with the agent's folder for each test. */
export function useVmLaunchHome(): void {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pap-vm-launch-"));
    mkdirSync(join(home, "agents", ID), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
}

export const row = (extra: Partial<SessionRow> = {}): SessionRow =>
  ({
    id: "s1",
    ownerId: "u1",
    agentId: ID,
    agentRole: "thread",
    cwd: home,
    piPath: null,
    ...extra,
  }) as SessionRow;
/** The id the agent form sent (AVM-E33) and the source the helper resolves it to: the runtime must get the source. */
export const PICK_ID = "c".repeat(32);
export const PICK_SOURCE = "npm:left-pad@1.0.0";
export const input = AgentInput.parse({
  name: "Atlas",
  resources: { memoryMb: 2048, cpus: 2, diskMb: 8192 },
  packages: [PICK_ID],
});
export const launch = (extra: Partial<AgentLaunch> = {}): AgentLaunch => ({
  agent: { id: ID, name: "Atlas", role: "r" },
  role: "thread",
  input,
  vm: true,
  ...extra,
});
export const vmLayout = (r: SessionRow): VmLayout =>
  layoutOf("process", home, {
    agentId: ID,
    taskKey: r.agentRole === "task" ? r.id.replaceAll("-", "") : null,
  });
/** The rules a daemon composes for the row, with the VM layout wired (or not). */
function rulesFor(r: SessionRow, wired: boolean) {
  const compose = createAgentRules({
    papHome: home,
    profileOf: () => ({ input, name: "Atlas", quarantined: false }),
    hostGrants: () => [],
    logger: silentLogger,
    ...(wired ? { vmLayoutOf: vmLayout } : {}),
  });
  return PolicyRules.parse({
    profile: "agent-thread",
    approvalMode: "supervised",
    ...compose(r, { allowHosts: null, denylist: [] }),
  });
}
export const hostInit = (r: SessionRow, wired = true): InitRecord => ({
  type: "init",
  cwd: join(home, "agents", ID),
  agentDir: join(home, "pi"),
  papHome: home,
  umask: 0o022,
  papSessionId: r.id,
  policy: rulesFor(r, wired),
  agent: { id: ID, name: "Atlas", role: "r" },
  vault: { TOKEN: "s3cret" },
});

export function setup(
  layoutForRuntime?: (r: SessionRow) => VmLayout,
  copyProviderScript?: (layout: VmLayout) => string,
  imageTagOf: (
    agentId: string,
    input: AgentLaunch["input"],
    kind: "thread" | "isolated",
    observe?: ImageObserver,
  ) => string | Promise<string> = () => IMAGE,
  recheck?: () => void,
  sources?: (ids: readonly string[] | null) => Promise<string[] | null>,
  spawnError?: Error,
  launches?: LaunchRegistry,
) {
  const worker = createFakeWorker({});
  const specs: VmSpec[] = [];
  const inputs: unknown[] = [];
  const packages: unknown[] = [];
  const spawn = vi.fn(async (spec: VmSpec, workerInput: unknown, picks: unknown) => {
    if (spawnError) throw spawnError;
    specs.push(spec);
    inputs.push(workerInput);
    packages.push(picks);
    const r = currentRow;
    return {
      handle: Object.assign(worker, { slot: SLOT, piFile: () => null }),
      layout: (layoutForRuntime ?? vmLayout)(r),
      relayKey: KEY,
      slot: SLOT,
    };
  });
  let currentRow = row();
  const inputFor = vi.fn((r: SessionRow) => ({
    sessionFile: null,
    sessionsDir: "/ignored",
    mirrorFor: () => "refused" as const,
    unsent: () => false,
    sent: () => {},
    marker: r.id,
  }));
  const vmLaunch = createVmLaunch({
    runtime: { spawn } as never,
    papHome: home,
    layoutOf: (r) => (r.agentId === undefined ? null : vmLayout(r)),
    joinLaunch: () => {},
    ...(launches ? { launches } : {}),
    imageTagOf,
    ...(recheck ? { recheck } : {}),
    mirrors: { inputFor },
    logger: silentLogger,
    // Mutant: the ids go to the runtime as they are -> "hands the runtime the sources, never the ids" fails.
    toImageEntries: (_agentId, _image, sources) =>
      sources === null
        ? null
        : sources.map((source) => (source === PICK_SOURCE ? `${PICK_SOURCE}#written` : source)),
    packageSources:
      sources ??
      (async (ids) => (ids === null ? null : ids.map((id) => (id === PICK_ID ? PICK_SOURCE : id)))),
    ...(copyProviderScript ? { copyProviderScript } : {}),
  });
  return {
    vmLaunch,
    worker,
    spawn,
    specs,
    inputs,
    packages,
    inputFor,
    use: (r: SessionRow) => (currentRow = r),
  };
}
