import { AGENT_PROMPT_LIMITS, AgentPromptName, type Caller, PapError } from "@pap/contracts";
import type { AgentFiles } from "../agent-vm/index.ts";
import type { AgentStore } from "./store.ts";

export interface PromptsDeps {
  readonly store: Pick<AgentStore, "get">;
  /** The files the owner imported into the agent (the host copy): the daemon never reads a VM disk. */
  readonly files: Pick<AgentFiles, "list" | "readOne">;
}

const PROMPTS_FOLDER = "prompts/";

/**
 * The prompt chips (M11R186): the `.md` files the owner imported directly under `prompts/` in the agent's files. Every agent
 * runs in a VM, so the chips come from the host copy of those imports, never from the VM home. The text is data for the
 * composer, never a prompt pap sends.
 */
export function createPrompts(deps: PromptsDeps) {
  const owned = (ownerId: string, agentId: string): void => {
    if (!deps.store.get(ownerId, agentId)) throw new PapError("not_found");
  };

  return {
    list(caller: Caller, agentId: string): { names: string[] } {
      owned(caller.userId, agentId);
      const names: string[] = [];
      for (const file of deps.files.list(agentId)) {
        if (!file.path.startsWith(PROMPTS_FOLDER)) continue;
        const name = file.path.slice(PROMPTS_FOLDER.length);
        if (AgentPromptName.safeParse(name).success) names.push(name);
      }
      return { names: names.sort().slice(0, AGENT_PROMPT_LIMITS.names) };
    },

    async read(caller: Caller, agentId: string, name: string): Promise<{ text: string }> {
      owned(caller.userId, agentId);
      if (!AgentPromptName.safeParse(name).success) throw new PapError("bad_request");
      const bytes = await deps.files.readOne(agentId, `${PROMPTS_FOLDER}${name}`);
      if (bytes === null) throw new PapError("not_found");
      if (bytes.length > AGENT_PROMPT_LIMITS.bytes) throw new PapError("payload_too_large");
      try {
        return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
      } catch {
        throw new PapError("bad_request");
      }
    },
  };
}
export type Prompts = ReturnType<typeof createPrompts>;
