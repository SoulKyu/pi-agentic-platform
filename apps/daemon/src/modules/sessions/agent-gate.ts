import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
  type AgentInput,
  bwrapArgv,
  type CommandInput,
  EGRESS_SOCKET,
  MODEL_NOT_OFFERED,
  MODEL_PROVIDER_UNKNOWN,
  type Notice,
  PapError,
  type SandboxSpec,
  SERVER_CODES,
  type VmLayout,
} from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import type { SandboxProbe } from "../../kernel/sandbox/probe.ts";
import { agentHomeOf, agentScratchOf } from "./agent-home.ts";
import type { LiveSession } from "./live-types.ts";
import type { EgressPort } from "./egress-link.ts";
import type { SessionRow } from "./store.ts";
import { VM_REFUSALS } from "./vm-rules.ts";

/** What the agents registry tells the sessions module about an agent (null: no such agent of this owner, or a profile that does not parse). */
export interface AgentProfile {
  readonly input: AgentInput;
  readonly name: string;
  readonly quarantined: boolean;
}

/** A waiting "use once" value as a worker gets it: the daemon's `expiresAt` (ms) travels with it (W5-R37). */
export interface OnceEntry {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly expiresAt: number;
}

/** The late-bound hand-over of the agents registry, the vault and the sandbox probe (`setAgentPorts`, M11R42). */
export interface SessionsAgentDeps {
  profileOf(ownerId: string, agentId: string): AgentProfile | null;
  /** The agent's decrypted vault (Task 13); none yet: `{}`. */
  vaultOf?(ownerId: string, agentId: string): Record<string, string>;
  /** The "use once" values waiting for this session (Task 18); none yet: `[]`. Never logged. */
  onceOf?(sessionId: string): OnceEntry[];
  /** The worker of this session used the waiting value of this name (`secret_used`). */
  onceUsed?(sessionId: string, id: string): void;
  readonly probe: { ensure(): Promise<SandboxProbe> };
  /** The egress proxy (M11R243): without it, or while it is not usable, no networked agent starts (M11R242). */
  readonly egress?: EgressPort;
  /** The owner's own host list, which an agent without one inherits (W5-R26); none: an empty list. */
  ownerHosts?(ownerId: string): readonly string[] | null;
  /** The owner's home folder, hidden from every agent shell; `os.homedir()` by default (the daemon passes its `userHome`). */
  readonly homeDir?: () => string;
  /** The VM layout of a session row that runs in a VM, else null (R15, R37). */
  vmLayoutOf?(row: SessionRow): VmLayout | null;
  /** The agent runs in a VM: no precheck, no chips (R16). */
  runsInVm?(ownerId: string, agentId: string): boolean;
}

export interface AgentGateDeps extends SessionsAgentDeps {
  readonly papHome: string;
  /** Pi's agent folder. */
  readonly agentDir: string;
  readonly logger: Logger;
}

/** What a launch of an agent session needs, read once by the gate (M11R53). Never logged. */
export interface AgentLaunch {
  readonly agent: { readonly id: string; readonly name: string; readonly role: string };
  readonly role: "thread" | "task" | "child";
  readonly input: AgentInput;
  /** Present exactly when the profile requires the sandbox. */
  readonly sandbox?: SandboxSpec;
  /** Present only with a sandbox, for a thread or a task (never a child). */
  readonly vault?: Record<string, string>;
  /** Present only with a sandbox and values waiting: the asking thread's "use once" values, handed to its worker at start. */
  readonly once?: OnceEntry[];
}

/**
 * M11R242, decision 90: a networked sandbox needs the probed interpreter and the daemon's forwarder file. Waits for the proxy's
 * boot; an unusable proxy refuses the launch, logged `agent_egress_refused`, and never falls back to a sandbox without network.
 */
async function egressOf(
  deps: AgentGateDeps,
  agentId: string,
  network: boolean,
): Promise<SandboxSpec["egress"]> {
  if (!network) return null;
  await deps.egress?.ready();
  const status = deps.egress?.status();
  const forwarder = deps.egress?.forwarderPath ?? null;
  if (status?.usable !== true || status.python === null || forwarder === null) {
    const reason = status === undefined ? "unbound" : (status.reason ?? "no_forwarder");
    deps.logger.warn("agent_egress_refused", { agentId, reason });
    throw new PapError("sandbox_unavailable");
  }
  return { python: status.python, forwarder };
}

const MAX_HIDDEN = 12;
/** Hidden besides the owner's home, `$PAP_HOME` and Pi's folder: logs, temporary files and where a core dump of the daemon or a worker can land (W5-R15, W5-R25). */
export const SYSTEM_HIDDEN = ["/var/log", "/var/tmp", "/var/crash", "/var/lib/systemd/coredump"] as const;
const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

/** The real path of an existing folder, or null: the worker refuses a link or a file in `hide`, and bwrap fails on a missing one. */
function realFolder(path: string): string | null {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * The folders hidden behind an empty tmpfs (owner m7, W5-R15): the owner's home, `$PAP_HOME`, Pi's agent folder, `/var/log` as a
 * whole, `/var/tmp` and the core-dump folders. Real folders that exist, once each; never a link spelling. No folder of the owner's home is added.
 */
function hiddenFolders(deps: AgentGateDeps, home: string): string[] {
  const candidates = [(deps.homeDir ?? homedir)(), deps.papHome, deps.agentDir, ...SYSTEM_HIDDEN];
  const real = candidates
    .map(realFolder)
    .filter((path): path is string => path !== null && !within(path, home));
  return [...new Set(real)].slice(0, MAX_HIDDEN);
}

/** The spec a worker or a precheck would build; one the argument list refuses is a refused start here, not a failed command later. */
function checkedSpec(deps: AgentGateDeps, agentId: string, parts: Omit<SandboxSpec, "hide">): SandboxSpec {
  const sandbox: SandboxSpec = { ...parts, hide: hiddenFolders(deps, parts.home) };
  try {
    bwrapArgv(sandbox, "true", EGRESS_SOCKET);
  } catch {
    deps.logger.warn("agent_sandbox_spec_invalid", { agentId });
    throw new PapError("invalid_cwd");
  }
  return sandbox;
}

/**
 * The sandbox of an agent trigger's precheck (M11R68): the system view, the home read-only, nothing writable, the agent's
 * network. Demanded whatever the profile's own `sandbox.required` says: a command pap runs without the owner never runs
 * unsandboxed. Fails closed like the launch gate: `sandbox_unavailable`, `not_found`, `agent_paused`, `invalid_cwd`.
 */
export async function agentPrecheckSandbox(
  deps: AgentGateDeps,
  ownerId: string,
  agentId: string,
): Promise<SandboxSpec> {
  const profile = deps.profileOf(ownerId, agentId);
  if (profile === null) throw new PapError("not_found");
  if (profile.quarantined) throw new PapError("agent_paused");
  if (deps.runsInVm?.(ownerId, agentId)) {
    deps.logger.warn("agent_precheck_refused", { agentId, reason: VM_REFUSALS.precheck });
    throw new PapError("sandbox_unavailable");
  }
  const home = agentHomeOf(deps.papHome, agentId, () =>
    deps.logger.warn("agent_home_mode_repaired", { agentId }),
  );
  const probe = await deps.probe.ensure();
  if (!probe.usable) {
    deps.logger.warn("agent_sandbox_refused", { agentId, reason: probe.reason });
    throw new PapError("sandbox_unavailable");
  }
  const { network } = profile.input.sandbox;
  return checkedSpec(deps, agentId, {
    bwrap: probe.path,
    view: "system",
    home,
    writable: null,
    network,
    egress: await egressOf(deps, agentId, network),
  });
}

/**
 * The gate of every launch of a session with an agent (M11R53, RT-06): new or reopened, after an idle release, a crash, an
 * unarchive or a prompt on a cold thread. Fails closed, with no unsandboxed fallback; the launch facts come back so
 * nothing is read twice. Two awaits only: the sandbox probe and, for a networked profile, the proxy's boot. Nothing else
 * awaits between this and the spawn.
 */
export async function agentGate(row: SessionRow, deps: AgentGateDeps): Promise<AgentLaunch> {
  const { agentId } = row;
  const role = row.agentRole;
  if (agentId === undefined || role === undefined) throw new PapError("bad_request");
  const profile = deps.profileOf(row.ownerId, agentId);
  if (profile === null) throw new PapError("not_found");
  if (profile.quarantined) throw new PapError("agent_paused");
  const home = agentHomeOf(deps.papHome, agentId, () =>
    deps.logger.warn("agent_home_mode_repaired", { agentId }),
  );
  const writable = role === "task" ? agentScratchOf(deps.papHome, agentId, row.cwd) : home;
  if (role !== "task" && row.cwd !== home) throw new PapError("invalid_cwd");
  const { input } = profile;
  const base = {
    agent: { id: agentId, name: profile.name, role: input.role },
    role,
    input,
  };
  if (!input.sandbox.required) return base;
  const probe = await deps.probe.ensure();
  if (!probe.usable) {
    deps.logger.warn("agent_sandbox_refused", { agentId, reason: probe.reason });
    throw new PapError("sandbox_unavailable");
  }
  const sandbox = checkedSpec(deps, agentId, {
    bwrap: probe.path,
    view: role === "task" ? "system" : "host",
    home,
    writable,
    network: input.sandbox.network,
    egress: await egressOf(deps, agentId, input.sandbox.network),
  });
  const vault = role === "child" ? undefined : (deps.vaultOf?.(row.ownerId, agentId) ?? {});
  // Read in the same synchronous step as the vault: a value that lands during the boot is brought by the drift check.
  const once = role === "child" ? undefined : deps.onceOf?.(row.id);
  return { ...base, sandbox, ...(vault ? { vault } : {}), ...(once?.length ? { once } : {}) };
}

/** The init record fields an agent launch adds (M11R54). */
export const initFieldsOf = (launch: AgentLaunch) => ({
  agent: launch.agent,
  ...(launch.sandbox ? { sandbox: launch.sandbox } : {}),
  ...(launch.vault ? { vault: launch.vault } : {}),
  ...(launch.once ? { once: launch.once } : {}),
});

/**
 * After `ready`: the profile's model and thinking level, for this session only (M7R42: never Pi's settings). A model the
 * runtime does not offer is reported `refused` (the worker's typed refusal), any other failure `failed`; neither fails
 * the start, and the session keeps the model it has. Neither the model's name nor the worker's words are logged.
 */
export async function applyProfileModel(
  session: Pick<LiveSession, "command">,
  launch: AgentLaunch,
  report: (what: "model" | "thinking", how: RefusedModel["how"]) => void,
): Promise<void> {
  const { model, thinking } = launch.input;
  const attempt = async (what: "model" | "thinking", input: CommandInput) => {
    try {
      const answer = await session.command(input);
      if (!answer.ok)
        report(
          what,
          answer.error === MODEL_NOT_OFFERED
            ? "refused"
            : answer.error === MODEL_PROVIDER_UNKNOWN
              ? "unknown-provider"
              : "failed",
        );
    } catch {
      report(what, "failed");
    }
  };
  if (model) await attempt("model", { type: "set_model", provider: model.provider, modelId: model.modelId });
  if (thinking) await attempt("thinking", { type: "set_thinking_level", level: thinking });
}

/** A param of a coded sentence holds 64 characters (`ServerParams`); the English text keeps the whole id. */
const PARAM_MAX = 64;
const asParam = (text: string): string =>
  text.length > PARAM_MAX ? `${text.slice(0, PARAM_MAX - 1)}…` : text;

/** Why the worker did not take the saved model, as the session's notice says it. */
export interface RefusedModel {
  readonly saved: { readonly provider: string; readonly modelId: string };
  /** What the worker runs on instead; null: it named none (Pi's default). */
  readonly running: { readonly provider: string; readonly id: string } | null;
  /**
   * `refused`: not offered; `unknown-provider`: not offered, and the worker has no such provider (an extension's when it
   * loads none); `failed`: the change did not go through (a timeout, a failed key check).
   */
  readonly how: "refused" | "unknown-provider" | "failed";
  /** The worker runs Chat only, which loads no extension: for a provider it lacks, the preset is the reason. */
  readonly chatOnly: boolean;
}

/**
 * The session's own line when the profile's model did not apply (the run keeps the model it has, M7R42): the saved
 * model, the one it runs on, and what the owner can do about it.
 */
export function refusedModelNotice({
  saved,
  running,
  how,
  chatOnly,
}: RefusedModel): Pick<Notice, "level" | "text" | "code" | "params"> {
  const model = `${saved.provider}/${saved.modelId}`;
  const params = { model: asParam(model) };
  if (how === "failed")
    return {
      level: "warning",
      text: `This agent's model ${model} could not be applied when its worker started, so it runs on another model. Settings › Models shows the provider's state.`,
      code: SERVER_CODES.agentModelNotApplied,
      params,
    };
  // Only a provider the worker lacks is Chat only's doing; a model of Pi's own providers is refused for what it is (N1).
  if (chatOnly && how === "unknown-provider")
    return {
      level: "warning",
      text: `This agent uses Chat only, which loads no extension: its model ${model} is not offered there, so it runs on another model. Choose a model Pi has, or another tool preset.`,
      code: SERVER_CODES.agentModelRefusedChat,
      params,
    };
  const where = "Settings › Models › Available models decides what is offered.";
  if (running === null)
    return {
      level: "warning",
      text: `This agent's model ${model} is not offered to its worker: it runs on Pi's default model instead. ${where}`,
      code: SERVER_CODES.agentModelRefusedDefault,
      params,
    };
  const now = `${running.provider}/${running.id}`;
  return {
    level: "warning",
    text: `This agent's model ${model} is not offered to its worker: it runs on ${now} instead. ${where}`,
    code: SERVER_CODES.agentModelRefused,
    params: { ...params, running: asParam(now) },
  };
}
