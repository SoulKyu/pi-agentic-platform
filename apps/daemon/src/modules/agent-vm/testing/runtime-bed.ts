import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_AGENT_RESOURCES, type InitRecord, PolicyRules } from "@pap/contracts";
import { createSystemClock } from "../../../kernel/clock.ts";
import { silentLogger } from "../../../kernel/logger.ts";
import {
  type AgentRuntime,
  type AgentRuntimeBackend,
  createAgentRuntime,
  createGateway,
  createLaunchTokens,
  createProcessBackend,
  type Gateway,
  layoutOf,
  type LaunchTokens,
  vmInitOf,
  type VmSpec,
  type VmWorkerHandle,
  type WorkerSpawnInput,
} from "../index.ts";

const REPO = fileURLToPath(new URL("../../../../../../", import.meta.url));
const VM_EXEC_ARGV = ["--conditions=development", "--disable-warning=ExperimentalWarning"];
export const IMAGE = `pap-agent-agent-${"a".repeat(64)}`;

/** Folders the process backend made read-only (RT-07) become writable again so a test can remove them. */
export const removeTree = (dir: string): void => {
  try {
    execFileSync("chmod", ["-R", "u+w", dir]);
  } catch {
    // Already gone.
  }
  rmSync(dir, { recursive: true, force: true });
};

/** The pids of this user's processes whose environment holds `needle` (`NAME=value`): the guest by launch, a worker by slot. */
export function pidsWithEnv(needle: string): number[] {
  const found: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${name}/environ`, "latin1").split("\0").includes(needle))
        found.push(Number(name));
    } catch {
      // Another user's process, or gone.
    }
  }
  return found;
}

export interface Spawned {
  readonly handle: VmWorkerHandle;
  readonly slot: string;
  readonly spec: VmSpec;
}

export interface RuntimeBed {
  readonly papHome: string;
  readonly tokens: LaunchTokens;
  readonly gateway: Gateway;
  readonly runtime: AgentRuntime;
  readonly scriptPath: string;
  /** Every `backend.start` (the launch id and token) and `backend.stop`, in order. */
  readonly launches: Array<{ launchId: string; token: string; agentId: string }>;
  readonly stops: Array<{ agentId: string; taskKey: string | null }>;
  /** The relay grants the runtime handed out (J1's relay link is not part of this bed). */
  readonly grants: Array<{ launchId: string; agentId: string; relayKey: string; address: string }>;
  readonly ended: string[];
  /** Spawns a worker in `agentId`'s VM (started if needed). `sessionFile`: a reopen. */
  spawn(agentId: string, input?: Partial<WorkerSpawnInput>): Promise<Spawned & { relayKey: string }>;
  /** Spawns a worker and sends it a VM init on the scripted provider; resolves when it is ready. */
  spawnReady(
    agentId: string,
    input?: Partial<WorkerSpawnInput>,
  ): Promise<Spawned & { relayKey: string; ready: Record<string, unknown> }>;
  dispose(): Promise<void>;
}

/**
 * A real gateway, the runtime and the process backend: the guest and its pi-host workers are local processes over a real
 * socket, on the scripted provider. No daemon around them: the tests of T6 and T7 together (J1).
 */
export async function startRuntimeBed(
  options: { script?: object; idleMs?: number; memoryCapMb?: number } = {},
): Promise<RuntimeBed> {
  const root = mkdtempSync(join(tmpdir(), "pap-rt-bed-"));
  const papHome = join(root, "home");
  const image = join(root, "image");
  mkdirSync(papHome, { recursive: true });
  mkdirSync(image, { recursive: true });
  writeFileSync(join(image, "settings.json"), "{}");
  const scriptPath = join(root, "script.json");
  writeFileSync(scriptPath, JSON.stringify(options.script ?? { steps: [{ text: "ok" }] }));
  const clock = createSystemClock();
  const tokens = createLaunchTokens();
  let imageOf: AgentRuntime["imageOf"] = () => null;
  const gateway = createGateway({ tokens, clock, logger: silentLogger, imageOf: (id) => imageOf(id) });
  const { port } = await gateway.listen("127.0.0.1", 0);
  const real = createProcessBackend({
    testSwitch: "process",
    papHome,
    guestEntry: join(REPO, "packages/pi-host/src/guest/main.ts"),
    execArgv: VM_EXEC_ARGV,
    imageAgentSource: image,
    gatewayAddress: () => ({ host: "127.0.0.1", port }),
    providerScript: scriptPath,
    clock,
    logger: silentLogger,
  });
  const launches: RuntimeBed["launches"] = [];
  const stops: RuntimeBed["stops"] = [];
  const backend: AgentRuntimeBackend = {
    start: (spec, launch) => (launches.push({ ...launch, agentId: spec.agentId }), real.start(spec, launch)),
    stop: (agentId, taskKey) => (stops.push({ agentId, taskKey }), real.stop(agentId, taskKey)),
    list: () => real.list(),
  };
  const grants: RuntimeBed["grants"] = [];
  const ended: string[] = [];
  const runtime = createAgentRuntime({
    backend,
    gateway,
    tokens,
    clock,
    logger: silentLogger,
    memoryCapMb: options.memoryCapMb ?? 8192,
    idleMs: options.idleMs ?? 0,
    layout: (spec) => layoutOf("process", papHome, spec),
    onLaunch: (grant) => void grants.push(grant),
    onLaunchEnd: (launchId) => void ended.push(launchId),
    onCrashPause: () => {},
    notifyCapacity: () => {},
  });
  imageOf = runtime.imageOf;
  await runtime.stopAll();

  const specOf = (agentId: string): VmSpec => ({
    agentId,
    kind: "thread",
    taskKey: null,
    image: IMAGE,
    resources: { ...DEFAULT_AGENT_RESOURCES, memoryMb: 512 },
  });
  const noMirror: WorkerSpawnInput = {
    sessionFile: null,
    sessionsDir: "",
    mirrorFor: () => "refused",
    sent: () => {},
  };
  async function spawn(agentId: string, input: Partial<WorkerSpawnInput> = {}) {
    const spec = specOf(agentId);
    const started = await runtime.spawn(spec, { ...noMirror, ...input }, null);
    return {
      handle: started.handle,
      slot: started.slot,
      spec,
      relayKey: started.relayKey,
      layout: started.layout,
    };
  }
  return {
    papHome,
    tokens,
    gateway,
    runtime,
    scriptPath,
    launches,
    stops,
    grants,
    ended,
    spawn: async (agentId, input) => {
      const started = await spawn(agentId, input);
      return { handle: started.handle, slot: started.slot, spec: started.spec, relayKey: started.relayKey };
    },
    async spawnReady(agentId, input) {
      const started = await spawn(agentId, input);
      const run = join(started.layout.root, "run");
      mkdirSync(run, { recursive: true });
      const script = join(run, "provider-script.json");
      copyFileSync(scriptPath, script);
      const rules = PolicyRules.parse({
        profile: "agent-thread",
        approvalMode: "full-access",
        agentHome: started.layout.home,
        sandbox: { required: true, network: false },
        readOnlyCommands: false,
      });
      const base: InitRecord = {
        type: "init",
        cwd: started.layout.home,
        agentDir: started.layout.piAgentDir,
        papHome: join(root, "unused"),
        umask: 0o022,
        policy: rules,
        agent: { id: agentId, name: "Atlas", role: "" },
      } as InitRecord;
      const init = vmInitOf(
        base,
        {
          layout: started.layout,
          bwrap: "/usr/bin/bwrap",
          rootView: "read-only",
          relayKey: started.relayKey,
          slot: started.slot,
        },
        input?.sessionFile ?? null,
      );
      init.testProviderScript = script;
      const ready = new Promise<Record<string, unknown>>((resolve) => {
        const off = started.handle.onRecord((record) => {
          if (record.type !== "ready") return;
          off();
          resolve(record as unknown as Record<string, unknown>);
        });
      });
      started.handle.send(init);
      return {
        handle: started.handle,
        slot: started.slot,
        spec: started.spec,
        relayKey: started.relayKey,
        ready: await ready,
      };
    },
    async dispose() {
      await runtime.stopAll().catch(() => {});
      await gateway.close().catch(() => {});
      removeTree(root);
    },
  };
}
