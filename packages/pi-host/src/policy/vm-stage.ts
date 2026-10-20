import type { ApprovalPlan, CallFacts, PipelineDeps, PolicyContext } from "./pipeline.ts";
import { judgeVmPath } from "./vm-paths.ts";

type Vm = NonNullable<PipelineDeps["vm"]>;

/** The built-in file tools whose path the VM file rule judges; `edit` and `write` as writes. */
const WRITES: ReadonlySet<string> = new Set(["edit", "write"]);
const JUDGED: ReadonlySet<string> = new Set(["read", "grep", "find", "ls", "edit", "write"]);
/** Tools whose `path` defaults to the cwd (`read`, `edit` and `write` have no default: no path is unreadable). */
const DEFAULTS_TO_CWD: ReadonlySet<string> = new Set(["grep", "find", "ls"]);

const pathOf = (input: unknown): unknown =>
  typeof input === "object" && input !== null ? (input as { path?: unknown }).path : undefined;

/**
 * Spec §5, R26: in a VM session every built-in file tool call is judged by the VM file rule first, in every mode, with no
 * question. A refusal blocks; null lets the call go on to the matrix. A tool that is not Pi's own (or pap's VM
 * registration of it) is left to stage 02.
 */
export async function vmFileRefusal(
  call: CallFacts,
  ctx: PolicyContext,
  vm: Vm,
): Promise<ApprovalPlan | null> {
  const tool = call.event.toolName;
  if (!call.kind.builtin || !JUDGED.has(tool)) return null;
  const named = pathOf(call.event.input);
  const raw = named === undefined && DEFAULTS_TO_CWD.has(tool) ? ctx.cwd : named;
  const verdict = await judgeVmPath(raw, ctx.cwd, vm.roots, WRITES.has(tool));
  if (verdict.ok) return null;
  return {
    outcome: "block",
    reason: verdict.reason,
    modelReason: `pap-policy blocked this call: ${verdict.reason}.`,
  };
}
