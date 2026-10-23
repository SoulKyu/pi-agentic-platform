import {
  type AgentInput,
  type CommandInput,
  MODEL_NOT_OFFERED,
  MODEL_PROVIDER_UNKNOWN,
  type Notice,
  PapError,
  SERVER_CODES,
  type VmLayout,
} from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import type { LiveSession } from "./live-types.ts";
import type { SessionRow } from "./store.ts";
import { vmGate } from "./vm-gate.ts";

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

/** The late-bound hand-over of the agents registry, the vault and the VM predicates (`setAgentPorts`, M11R42). */
export interface SessionsAgentDeps {
  profileOf(ownerId: string, agentId: string): AgentProfile | null;
  /** The agent's decrypted vault (Task 13); none yet: `{}`. */
  vaultOf?(ownerId: string, agentId: string): Record<string, string>;
  /** The "use once" values waiting for this session (Task 18); none yet: `[]`. Never logged. */
  onceOf?(sessionId: string): OnceEntry[];
  /** The worker of this session used the waiting value of this name (`secret_used`). */
  onceUsed?(sessionId: string, id: string): void;
  /** The VM layout of a session row that runs in a VM, else null (R15, R37). */
  vmLayoutOf?(row: SessionRow): VmLayout | null;
  /**
   * ADR 0080: the Claude Code environment of an agent that uses pi-claude-bridge (`{}` for any other): `home` is the VM layout's
   * home or the agent's host home. Never logged.
   */
  claudeEnvOf?(
    input: AgentInput,
    where: { readonly vm: boolean; readonly home: string },
  ): Promise<Readonly<Record<string, string>>>;
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
  /** For a thread or a task (never a child, RT-07). */
  readonly vault?: Record<string, string>;
  /** The asking thread's "use once" values, handed to its worker at start. */
  readonly once?: OnceEntry[];
  /** The session runs in a VM (`vmGate`): every agent session does. */
  readonly vm?: true;
  /** ADR 0080: the extra environment of the worker, present only for an agent that uses pi-claude-bridge. */
  readonly claudeEnv?: Readonly<Record<string, string>>;
}

const withClaudeEnv = <T extends object>(
  launch: T,
  claudeEnv: Readonly<Record<string, string>> | undefined,
): T & Pick<AgentLaunch, "claudeEnv"> =>
  claudeEnv !== undefined && Object.keys(claudeEnv).length > 0 ? { ...launch, claudeEnv } : launch;

/**
 * The gate of every launch of a session with an agent (M11R53, RT-06): new or reopened, after an idle release, a crash, an
 * unarchive or a prompt on a cold thread. Agents run in microVMs only: a row with no VM layout (no VM stack on this machine)
 * is refused `sandbox_unavailable`, never started elsewhere. The launch facts come back so nothing is read twice.
 */
export async function agentGate(row: SessionRow, deps: AgentGateDeps): Promise<AgentLaunch> {
  if (row.agentId === undefined || row.agentRole === undefined) throw new PapError("bad_request");
  const layout = deps.vmLayoutOf?.(row);
  if (!layout) {
    deps.logger.warn("agent_vm_unavailable", { agentId: row.agentId });
    throw new PapError("sandbox_unavailable");
  }
  const launch = await vmGate(row, deps);
  const claudeEnv = await deps.claudeEnvOf?.(launch.input, { vm: true, home: layout.home });
  // ADR 0081: a thread or a task gets the vault and its waiting one-use values, read in one synchronous step with the
  // return: a value that lands during the boot is brought by the drift check. A child never holds the vault (RT-07).
  const vault = row.agentRole === "child" ? undefined : (deps.vaultOf?.(row.ownerId, row.agentId) ?? {});
  const once = row.agentRole === "child" ? undefined : deps.onceOf?.(row.id);
  return withClaudeEnv(
    { ...launch, ...(vault ? { vault } : {}), ...(once?.length ? { once } : {}) },
    claudeEnv,
  );
}

/** The init record fields an agent launch adds (M11R54). */
export const initFieldsOf = (launch: AgentLaunch) => ({
  agent: launch.agent,
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
