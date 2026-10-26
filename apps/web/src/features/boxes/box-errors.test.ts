import { describe, expect, it } from "vitest";
import { RpcError, type RpcErrorCode } from "../../runtime/index.ts";
import { agentBoxFailure, boxFailure } from "./box-errors.ts";
import { useBoxAction } from "./use-box-action.ts";

describe("box failures", () => {
  it.each<[RpcErrorCode, string]>([
    ["not_found", "boxes.error.not_found"],
    ["capacity", "boxes.error.capacity"],
    ["agent_paused", "boxes.error.agent_paused"],
    ["vm_bundle_stale", "boxes.error.vm_bundle_stale"],
    ["sandbox_unavailable", "boxes.error.sandbox_unavailable"],
    ["disk_low", "boxes.error.disk_low"],
  ])("a project keeps its words for %s", (code, key) => {
    expect(boxFailure(new RpcError(code))).toBe(key);
  });

  it.each<[RpcErrorCode, string]>([
    ["not_found", "boxes.agentError.not_found"],
    ["capacity", "boxes.agentError.capacity"],
    ["agent_paused", "boxes.agentError.agent_paused"],
    ["vm_bundle_stale", "boxes.agentError.vm_bundle_stale"],
    ["sandbox_unavailable", "boxes.agentError.sandbox_unavailable"],
    ["disk_low", "boxes.agentError.disk_low"],
    ["command_failed", "boxes.agentError.fallback"],
    ["internal", "boxes.agentError.fallback"],
  ])("an agent's VM has its own key for %s", (code, key) => {
    expect(agentBoxFailure(new RpcError(code))).toBe(key);
  });

  it("a code the box has no words for keeps the house text", () => {
    expect(agentBoxFailure(new RpcError("timeout"))).toBe(boxFailure(new RpcError("timeout")));
  });
});

/** Type-level: an agent box takes the start action only (never called). */
export function useAgentBoxTakesStartOnly() {
  useBoxAction("projects.startBox", { kind: "agent", id: "atlas-1a2b" });
  // @ts-expect-error a restart has no agent box
  useBoxAction("projects.restartBox", { kind: "agent", id: "atlas-1a2b" });
  // @ts-expect-error a rebuild has no agent box
  useBoxAction("projects.rebuild", { kind: "agent", id: "atlas-1a2b" });
}
