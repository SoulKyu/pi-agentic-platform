import { type AgentFileView, type Caller, PapError } from "@pap/contracts";
import type { AuditPort } from "../audit/index.ts";
import type { AgentFiles } from "./agent-files.ts";

export interface AgentFilesService {
  /** `not_found` unless the agent is the caller's. The HTTP route asks before it reads a body. */
  check(caller: Caller, agentId: string): void;
  list(caller: Caller, agentId: string): { files: AgentFileView[] };
  put(caller: Caller, agentId: string, path: string, bytes: Buffer): AgentFileView;
  remove(caller: Caller, agentId: string, path: string): { ok: true };
}

/**
 * The owner's view of an agent's files (spec 7): ownership first (another owner's agent is `not_found`, nothing touched), one
 * store call, one audit row. A row names the agent, the path and the size, never the content. The browser-only rule is the
 * permission (`agents:admin` is outside the token permissions) and, for the import, the cookie-only HTTP route.
 */
export function createAgentFilesService(deps: {
  readonly files: Pick<AgentFiles, "list" | "put" | "remove">;
  readonly owns: (ownerId: string, agentId: string) => boolean;
  readonly audit: Pick<AuditPort, "append">;
}): AgentFilesService {
  const { files, audit } = deps;
  const check = (caller: Caller, agentId: string): void => {
    if (!deps.owns(caller.userId, agentId)) throw new PapError("not_found");
  };
  const record = (caller: Caller, reason: string, detail: Record<string, string | number>): void =>
    audit.append({ ownerId: caller.userId, actor: "user", kind: "policy", reason, detail });
  return {
    check,
    list(caller, agentId) {
      check(caller, agentId);
      return { files: files.list(agentId) };
    },
    put(caller, agentId, path, bytes) {
      check(caller, agentId);
      const view = files.put(agentId, path, bytes);
      record(caller, "agent file imported", { agentId, path, bytes: view.size });
      return view;
    },
    remove(caller, agentId, path) {
      check(caller, agentId);
      files.remove(agentId, path);
      record(caller, "agent file removed", { agentId, path });
      return { ok: true };
    },
  };
}
