import { type BoxRef, type Caller, LAUNCH_LIMITS, PapError } from "@pap/contracts";

/** What "Show the log" reads from: the project's owner and the lines of the build the box's launch waits for. */
export interface LaunchLogSource {
  projectOwner(projectId: string): string | null;
  /** Already redacted; empty when nothing builds. */
  buildLog(boxId: string): Promise<readonly string[]>;
}

export interface LaunchLog {
  /** The agents registry's answer to "who owns this agent". Until it is bound no agent is anyone's. */
  bindAgentOwner(ownerOf: (agentId: string) => string | null): void;
  bind(source: LaunchLogSource): void;
  /**
   * The caller's own box only (another owner's, an unknown one and an unbound source are all `not_found`); the permission is
   * the box kind's read: `agents:read` for an agent, `sessions:read` for a project. Up to 200 lines of at most 512 characters.
   */
  read(caller: Pick<Caller, "userId" | "permissions">, box: BoxRef): Promise<{ lines: string[] }>;
}

export function createLaunchLog(): LaunchLog {
  let agentOwner: (agentId: string) => string | null = () => null;
  let source: LaunchLogSource | null = null;
  return {
    bindAgentOwner: (ownerOf) => void (agentOwner = ownerOf),
    bind: (next) => void (source = next),
    async read(caller, box) {
      if (!caller.permissions.has(box.kind === "agent" ? "agents:read" : "sessions:read"))
        throw new PapError("forbidden");
      const owner = box.kind === "agent" ? agentOwner(box.id) : (source?.projectOwner(box.id) ?? null);
      if (source === null || owner === null || owner !== caller.userId) throw new PapError("not_found");
      const lines = await source.buildLog(box.id);
      return {
        lines: lines.slice(-LAUNCH_LIMITS.logLines).map((line) => line.slice(0, LAUNCH_LIMITS.lineChars)),
      };
    },
  };
}
