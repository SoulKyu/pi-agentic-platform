import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AgentInput, type MethodName, type ParamsOf, type VmdRequest } from "@pap/contracts";
import type { AgentsVm } from "../compose-agents-vm.ts";
import { createVmdClient, VMD_SOCKET, type VmdClient } from "../modules/agent-vm/index.ts";
import { createSystemClock } from "../kernel/clock.ts";
import { type Owner, openOwner, result } from "../security/testing/automation-bed.ts";
import { captureLogger } from "./capture-logger.ts";
import { type TestDaemon, startTestDaemon } from "./harness.ts";
import { type KataLlm, type KataReply, startKataLlm } from "./kata-llm.ts";
import { writeProbePackage } from "./kata-probe.ts";

/** AVM-E56: the home pap-vmd was set up with on this host. The bed's daemon runs on it (pap-vmd reads its staging and build folders). */
export const KATA_HOME = join(homedir(), ".pap-kata");
const VM_EXEC_ARGV = ["--conditions=development", "--disable-warning=ExperimentalWarning"];
/** The first run of an agent builds three image layers (minutes); later runs reuse them. */
export const LONG_MS = 15 * 60_000;

/** Why the Kata tests cannot run here, or null. */
export function kataUnavailable(): string | null {
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
  } catch {
    return "/dev/kvm is missing or not usable by this user";
  }
  try {
    if (!statSync(VMD_SOCKET).isSocket()) return `${VMD_SOCKET} is not a socket`;
  } catch {
    return `${VMD_SOCKET} is missing (pap-vmd is not installed or not running)`;
  }
  return null;
}

let warned = false;
/** True when the Kata tests are skipped: one warning; under `CI=1` a missing stack fails the run instead. */
export function skipKata(): boolean {
  const reason = kataUnavailable();
  if (reason === null) return false;
  if (process.env.CI === "1") throw new Error(`the Kata tests need the real stack: ${reason}`);
  if (!warned) process.stderr.write(`Kata tests skipped: ${reason}\n`);
  warned = true;
  return true;
}

/** Empties the bed's own home between tests; refuses any folder that is not the one pap-vmd was set up with (never ~/.pap). */
export function emptyKataHome(): void {
  const configured = (JSON.parse(readFileSync("/etc/pap-vm/config.json", "utf8")) as { papHome?: string })
    .papHome;
  if (configured !== KATA_HOME || basename(KATA_HOME) !== ".pap-kata")
    throw new Error(`pap-vmd was set up with ${configured}, not ${KATA_HOME}: refusing to empty anything`);
  emptyFolder(KATA_HOME);
}

/** Removes everything inside `folder`; a link is refused (its target's contents would go), never followed. */
export function emptyFolder(folder: string): void {
  if (lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink() === true)
    throw new Error(`${folder} is a link: refusing to empty what it points to`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(folder)) rmSync(join(folder, name), { recursive: true, force: true });
}

export interface KataBed {
  readonly t: TestDaemon;
  readonly owner: Owner;
  /** A call that must succeed; a launch can wait minutes for the first image build, so the deadline is long. */
  readonly call: <T>(method: MethodName, params: object) => Promise<T>;
  readonly vm: AgentsVm;
  readonly llm: KataLlm;
  /** The last lines the daemon logged: a failed test prints them. */
  problems(): string[];
  /** The real pap-vmd, for checks the daemon makes no call for. */
  readonly vmd: VmdClient;
  /** Every `vm.start` the daemon sent: the launch token is in the request, so a test can look for it inside the VM. */
  readonly starts: Array<Extract<VmdRequest, { op: "vm.start" }>>;
  /** Every launch's relay key, in order: a test looks for it inside the VM (spec §3). */
  readonly grants: Array<{ launchId: string; agentId: string; relayKey: string }>;
  createAgent(input?: Record<string, unknown>): Promise<string>;
  /** Saves the agent's profile with `patch` merged over the bed's defaults (a resize, say). */
  update(agentId: string, patch: Record<string, unknown>): Promise<void>;
  openThread(agentId: string): Promise<string>;
  /** Sends a prompt and waits for the run to end (a cold start included). */
  prompt(sessionId: string, text: string): Promise<void>;
  /** Runs `cmd` inside the VM as the worker (guest root) through the probe tool; resolves with its output. */
  probe(agentId: string, sessionId: string, cmd: string): Promise<string>;
  /** Runs `command` through pap's own `bash` tool (the sandboxed shell in the VM); resolves with what the model was given. */
  shell(agentId: string, sessionId: string, command: string): Promise<string>;
  /** Runs a Python 3 script inside the VM (the image has python3), passed encoded so no quoting or token text reaches an argv. */
  python(agentId: string, sessionId: string, script: string): Promise<string>;
  /** The agent's mirrored transcript, one parsed entry per line. */
  transcript(agentId: string): Array<Record<string, unknown>>;
  stop(): Promise<void>;
}

const textOfResult = (entry: Record<string, unknown>): string => {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content)
    ? content.map((part) => ((part as { text?: unknown }).text as string | undefined) ?? "").join("")
    : "";
};

/**
 * A whole daemon on the real Kata stack: its `PAP_HOME` is `KATA_HOME`, its VMs are pap-vmd's, its relay is the real `pap-relay` on
 * pap0's address in front of a scripted model on loopback. Nothing reaches a public host. One bed at a time (the ports are fixed).
 */
export async function startKataBed(
  options: {
    workerIdleMs?: number;
    probe?: boolean;
    modelFiles?: Readonly<Record<string, string>>;
    /** `false`: do not wait for the relay (a test that holds its port first). Default: wait. */
    awaitRelay?: boolean;
  } = {},
): Promise<KataBed> {
  emptyKataHome();
  const root = mkdtempSync(join(tmpdir(), "pap-kata-"));
  const llm = await startKataLlm();
  const probeDir = writeProbePackage(root);
  const model = {
    id: "m-1",
    name: "M1",
    reasoning: false,
    input: ["text"],
    contextWindow: 32_000,
    maxTokens: 4_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const agentFiles = {
    "models.json": JSON.stringify({
      providers: {
        scripted: {
          baseUrl: llm.baseUrl,
          api: "openai-completions",
          apiKey: "sk-t20a-owner-key",
          models: [model],
        },
      },
    }),
    "settings.json": JSON.stringify({
      defaultProvider: "scripted",
      defaultModel: "m-1",
      enabledModels: ["scripted/m-1"],
      packages: options.probe === false ? [] : [probeDir],
    }),
    ...options.modelFiles,
  };
  const starts: KataBed["starts"] = [];
  const grants: KataBed["grants"] = [];
  const real = createVmdClient(VMD_SOCKET, createSystemClock());
  const recording: VmdClient = {
    request(request) {
      if (request.op === "vm.start") starts.push(request);
      return real.request(request);
    },
  };
  let exposed: AgentsVm | undefined;
  let t: TestDaemon | undefined;
  const captured = captureLogger();
  try {
    t = await startTestDaemon(
      { steps: [] },
      {
        root,
        agentFiles,
        config: {
          home: KATA_HOME,
          testAgentRuntime: null,
          workerIdleMs: options.workerIdleMs ?? 30 * 60_000,
        },
        deps: {
          logger: captured.logger,
          agentsVm: {
            kata: { client: recording },
            relayExecArgv: VM_EXEC_ARGV,
            expose: (vm) => void (exposed = vm),
            observe: { granted: (grant) => void grants.push(grant) },
          },
        },
      },
    );
  } catch (error) {
    await llm.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const daemon = t;
  const owner = await openOwner(daemon);
  const call = async <T>(method: MethodName, params: object): Promise<T> =>
    result<T>(await owner.client.call(method, params as ParamsOf<typeof method>, LONG_MS));
  if (exposed === undefined) throw new Error("the VM composition was not exposed");
  // A launch is refused until the relay listens (AVM-E54): the real relay child starts after the bridge exists.
  if (options.awaitRelay !== false) await exposed.relay?.whenReady();
  /** Every agent this bed made: its VMs and its disk (4 GiB each, a third of it written at the first boot) go at the end. */
  const made: string[] = [];
  /** The subscription of each opened thread: sequence numbers are per subscription, so a wait looks at one only. */
  const subs = new Map<string, string>();
  const inputOf = (extra: Record<string, unknown>) =>
    AgentInput.parse({
      name: "CyberLooker",
      mode: "full-access",
      preset: "full",
      sandbox: { required: true, network: false },
      model: { provider: "scripted", modelId: "m-1" },
      ...extra,
    });
  const transcript = (agentId: string): Array<Record<string, unknown>> => {
    const dir = join(KATA_HOME, "agents", ".mirrors", agentId);
    const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    return files.flatMap((name) =>
      readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    );
  };
  /** One scripted tool call, then its result from the mirrored transcript. */
  const runTool = async (
    agentId: string,
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
    label: string,
  ): Promise<string> => {
    // The scripted model names each tool call `call_<n>` by the request it answers: that id finds this call's result among the
    // entries of every session of the agent (a thread and its tasks mirror into one folder).
    const callId = `call_${llm.served() + 1}`;
    llm.push({ tool, args } satisfies KataReply, { text: "done" });
    await bed.prompt(sessionId, `${tool}: ${label.slice(0, 40)}`);
    const found = transcript(agentId).find(
      (entry) =>
        (entry.message as { role?: string; toolCallId?: string } | undefined)?.role === "toolResult" &&
        (entry.message as { toolCallId?: string }).toolCallId === callId,
    );
    if (found === undefined) throw new Error(`the ${tool} tool answered nothing`);
    // Pi wraps a tool's text as untrusted content: the command's own output is what lies between the tags.
    return textOfResult(found).replace(/<\/?untrusted[^>]*>\n?/g, "");
  };
  const bed: KataBed = {
    t: daemon,
    owner,
    call,
    vm: exposed,
    llm,
    vmd: recording,
    starts,
    grants,
    problems: () => captured.lines.slice(-60).map((line) => JSON.stringify(line).slice(0, 500)),
    async createAgent(input = {}) {
      const created = await call<{ id: string }>("agents.create", { input: inputOf(input) });
      made.push(created.id);
      return created.id;
    },
    async update(agentId, patch) {
      const view = await call<{ revision: number }>("agents.get", { agentId });
      await call("agents.update", { agentId, baseRevision: view.revision, input: inputOf(patch) });
    },
    async openThread(agentId) {
      const { sessionId } = await call<{ sessionId: string }>("agents.openThread", { agentId });
      const { sub } = await call<{ sub: string }>("subscribe.session", { sessionId });
      subs.set(sessionId, sub);
      return sessionId;
    },
    async prompt(sessionId, text) {
      const sub = subs.get(sessionId);
      const mark = owner.client.events.filter((f) => f.sub === sub).at(-1)?.seq ?? -1;
      const status = (name: string) => (frame: { event: unknown; seq: number; sub: string }) =>
        frame.sub === sub && (frame.event as { status?: string }).status === name;
      // A reopened session is tainted (its mirror was resynced): its tools ask once. The bed answers `once`, like an owner would.
      const answered = new Set<string>();
      const approver = setInterval(() => {
        for (const frame of owner.client.events) {
          const event = frame.event as { kind?: string; dialog?: { id: string; method?: string } };
          if (
            frame.sub !== sub ||
            frame.seq <= mark ||
            event.kind !== "dialog_open" ||
            event.dialog?.method !== "approval"
          )
            continue;
          if (answered.has(event.dialog.id)) continue;
          answered.add(event.dialog.id);
          void call("sessions.respondDialog", {
            sessionId,
            dialogId: event.dialog.id,
            response: { answer: "once" },
          });
        }
      }, 200);
      try {
        await call("sessions.prompt", { sessionId, text });
        const running = await owner.client.waitForEvent((f) => status("running")(f) && f.seq > mark, LONG_MS);
        await owner.client.waitForEvent((f) => status("idle")(f) && f.seq > running.seq, LONG_MS);
      } finally {
        clearInterval(approver);
      }
    },
    probe: (agentId, sessionId, cmd) => runTool(agentId, sessionId, "probe", { cmd }, cmd),
    shell: (agentId, sessionId, command) => runTool(agentId, sessionId, "bash", { command }, command),
    python: (agentId, sessionId, script) =>
      bed.probe(agentId, sessionId, `echo ${Buffer.from(script).toString("base64")} | base64 -d | python3 -`),
    transcript,
    async stop() {
      owner.client.close();
      try {
        await daemon.stop();
      } finally {
        await llm.close();
        rmSync(root, { recursive: true, force: true });
        await removeAgents(recording, made);
      }
    },
  };
  return bed;
}

/** The thread VM and the task VMs pap-vmd lists for an agent. */
export async function vmsOf(
  vmd: VmdClient,
  agentId: string,
): Promise<Array<{ taskKey: string | null; state: string }>> {
  const listed = (await vmd.request({ op: "vm.list" })) as {
    vms: Array<{ agentId: string; taskKey: string | null; state: string }>;
  };
  return listed.vms.filter((vm) => vm.agentId === agentId);
}

/** Stops whatever VM of these agents is left and deletes their disks for good (a test's agents are never worth keeping). */
export async function removeAgents(
  vmd: VmdClient,
  agentIds: readonly string[],
  say: (line: string) => void = (line) => void process.stderr.write(`${line}\n`),
): Promise<void> {
  const tolerate = async (op: string, agentId: string, call: Promise<unknown>): Promise<void> => {
    try {
      await call;
    } catch (error) {
      say(`kata bed: ${op} of ${agentId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  for (const agentId of agentIds) {
    for (const vm of await vmsOf(vmd, agentId))
      await tolerate("vm.stop", agentId, vmd.request({ op: "vm.stop", agentId, taskKey: vm.taskKey }));
    await tolerate(
      "disk.delete",
      agentId,
      vmd.request({ op: "disk.delete", agentId, taskKey: null, purge: true }),
    );
  }
}
