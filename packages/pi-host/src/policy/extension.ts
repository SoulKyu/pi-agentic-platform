import type {
  ExtensionFactory,
  ExtensionUIContext,
  InlineExtension,
  LoadExtensionsResult,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { AuditEntry, PolicyRules, ToolCategory } from "@pap/contracts";
import { describeCall, toolCategory } from "./categories.ts";
import { type Decision, decide, decideEdit } from "./decide.ts";
import { isInsideCwd } from "./target-path.ts";

export const POLICY_EXTENSION_NAME = "pap-policy";
// What Pi reports as the path of an inline extension (measured in docs/spikes/s1.md).
export const POLICY_EXTENSION_PATH = `<inline:${POLICY_EXTENSION_NAME}>`;
export const DENIED_REASON = "Denied by the user.";
export const FAIL_CLOSED_REASON = "pap-policy could not evaluate this call, so it was blocked (fail closed).";

const OUTSIDE_CWD_REASON = "outside the session directory";

const TITLES: Readonly<Record<ToolCategory, string>> = {
  read: "Allow reading?",
  edit: "Allow this edit?",
  exec: "Run a command?",
  network: "Allow a network request?",
  "external-write": "Allow this tool?",
  unknown: "Allow this tool?",
};

export interface PolicyDeps {
  rules(): PolicyRules | null;
  audit(entry: AuditEntry): void;
}

interface PolicyEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

interface PolicyContext {
  readonly hasUI: boolean;
  readonly cwd: string;
  readonly ui: Pick<ExtensionUIContext, "confirm">;
}

type NamedInlineExtension = Exclude<InlineExtension, ExtensionFactory>;

async function decideCall(
  event: PolicyEvent,
  category: ToolCategory,
  rules: PolicyRules,
  cwd: string,
): Promise<{ decision: Decision; reason?: string }> {
  if (category !== "edit") return { decision: decide(category, rules) };
  const target =
    typeof event.input === "object" && event.input !== null
      ? (event.input as { path?: unknown }).path
      : undefined;
  const insideCwd = await isInsideCwd(target, cwd);
  return insideCwd
    ? { decision: decideEdit(rules, true) }
    : { decision: decideEdit(rules, false), reason: OUTSIDE_CWD_REASON };
}

export async function evaluateToolCall(
  event: PolicyEvent,
  ctx: PolicyContext,
  deps: PolicyDeps,
): Promise<ToolCallEventResult | undefined> {
  let category: ToolCategory = "unknown";
  const record = (decision: AuditEntry["decision"], reason?: string) =>
    deps.audit({
      toolCallId: event.toolCallId,
      tool: event.toolName,
      category,
      decision,
      ...(reason ? { reason } : {}),
    });
  try {
    category = toolCategory(event.toolName);
    const rules = deps.rules();
    if (!rules) {
      record("block", "no valid policy rules");
      return { block: true, reason: FAIL_CLOSED_REASON };
    }
    const { decision, reason } = await decideCall(event, category, rules, ctx.cwd);
    if (decision === "allow") {
      record("allow");
      return undefined;
    }
    if (decision === "block" || !ctx.hasUI) {
      record("block", decision === "block" ? (reason ?? "category blocked") : "no UI to ask");
      return { block: true, reason: `pap-policy blocked this ${category} call.` };
    }
    const approved = await ctx.ui.confirm(TITLES[category], describeCall(event.toolName, event.input));
    record(approved ? "approved" : "denied", reason);
    return approved ? undefined : { block: true, reason: DENIED_REASON };
  } catch {
    try {
      record("block", "evaluation error");
    } catch {
      // The audit sink is what failed, or failed again: the block below is the only safe answer.
    }
    return { block: true, reason: FAIL_CLOSED_REASON };
  }
}

export function createPapPolicyExtension(deps: PolicyDeps): NamedInlineExtension {
  return {
    name: POLICY_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("tool_call", (event, ctx) => evaluateToolCall(event, ctx, deps));
    },
  };
}

export function movePolicyLast(base: LoadExtensionsResult): LoadExtensionsResult {
  const policy = base.extensions.find((extension) => extension.path === POLICY_EXTENSION_PATH);
  if (!policy) throw new Error("pap-policy is not loaded: refusing to start the session");
  return { ...base, extensions: [...base.extensions.filter((extension) => extension !== policy), policy] };
}
