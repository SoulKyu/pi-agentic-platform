import type {
  ExtensionFactory,
  ExtensionUIContext,
  InlineExtension,
  LoadExtensionsResult,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { AuditEntry, PolicyRules, ToolCategory } from "@pap/contracts";
import { toolCategory } from "./categories.ts";
import { type Decision, decide, decideEdit } from "./decide.ts";
import { describeCall } from "./describe-call.ts";
import { checkEditTarget, type EditReview } from "./target-path.ts";

export const POLICY_EXTENSION_NAME = "pap-policy";
// What Pi reports as the path of an inline extension (measured in docs/spikes/s1.md).
export const POLICY_EXTENSION_PATH = `<inline:${POLICY_EXTENSION_NAME}>`;
export const DENIED_REASON = "Denied by the user.";
export const FAIL_CLOSED_REASON = "pap-policy could not evaluate this call, so it was blocked (fail closed).";
export const TOO_LONG_REASON = "too long to review — split the work";

const MAX_AUDIT_FIELD = 256;

const TITLES: Readonly<Record<ToolCategory, string>> = {
  read: "Allow reading?",
  edit: "Allow this edit?",
  exec: "Run a command?",
  network: "Allow a network request?",
  "external-write": "Allow this tool?",
  unknown: "Allow this tool?",
};

export interface PolicyConfig {
  rules(): PolicyRules | null;
  audit(entry: AuditEntry): void;
  /** The Pi agent directory of the session: settings, extensions and credentials live there. */
  agentDir: string;
  /** pap's data directory: the database, secrets and agent homes live there. */
  papHome: string;
}

export interface PolicyDeps extends PolicyConfig {
  /** Whether `toolName` is the tool Pi ships under that name, not an extension that took the name over. */
  isBuiltinTool(toolName: string): boolean;
}

interface PolicyEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

interface PolicyContext {
  readonly hasUI: boolean;
  readonly cwd: string;
  readonly signal?: AbortSignal | undefined;
  readonly ui: Pick<ExtensionUIContext, "confirm">;
}

type NamedInlineExtension = Exclude<InlineExtension, ExtensionFactory>;

async function decideCall(
  event: PolicyEvent,
  category: ToolCategory,
  rules: PolicyRules,
  ctx: PolicyContext,
  protectedRoots: readonly string[],
): Promise<{ decision: Decision; review?: EditReview }> {
  if (category !== "edit") return { decision: decide(category, rules) };
  const target =
    typeof event.input === "object" && event.input !== null
      ? (event.input as { path?: unknown }).path
      : undefined;
  const check = await checkEditTarget(target, ctx.cwd, protectedRoots);
  return check.auto
    ? { decision: decideEdit(rules, true) }
    : { decision: decideEdit(rules, false), review: check.review };
}

export async function evaluateToolCall(
  event: PolicyEvent,
  ctx: PolicyContext,
  deps: PolicyDeps,
): Promise<ToolCallEventResult | undefined> {
  let category: ToolCategory = "unknown";
  const record = (decision: AuditEntry["decision"], reason?: string) =>
    deps.audit({
      toolCallId: event.toolCallId.slice(0, MAX_AUDIT_FIELD),
      tool: event.toolName.slice(0, MAX_AUDIT_FIELD),
      category,
      decision,
      ...(reason ? { reason } : {}),
    });
  try {
    category = deps.isBuiltinTool(event.toolName) ? toolCategory(event.toolName) : "unknown";
    const rules = deps.rules();
    if (!rules) {
      record("block", "no valid policy rules");
      return { block: true, reason: FAIL_CLOSED_REASON };
    }
    const { decision, review } = await decideCall(event, category, rules, ctx, [deps.agentDir, deps.papHome]);
    if (decision === "allow") {
      record("allow");
      return undefined;
    }
    if (decision === "block" || !ctx.hasUI) {
      record("block", decision === "block" ? (review?.why ?? "category blocked") : "no UI to ask");
      return { block: true, reason: `pap-policy blocked this ${category} call.` };
    }
    const description = describeCall(event.toolName, event.input, { exec: category === "exec", review });
    if (!description.reviewable) {
      record("block", "too long to review");
      return { block: true, reason: TOO_LONG_REASON };
    }
    const approved = await ctx.ui.confirm(TITLES[category], description.message, { signal: ctx.signal });
    record(approved ? "approved" : "denied", review?.why);
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

export function createPapPolicyExtension(config: PolicyConfig): NamedInlineExtension {
  return {
    name: POLICY_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      const deps: PolicyDeps = {
        ...config,
        isBuiltinTool: (toolName) =>
          pi
            .getAllTools()
            .some((tool) => tool.name === toolName && tool.sourceInfo.path === `builtin:${toolName}`),
      };
      pi.on("tool_call", (event, ctx) => evaluateToolCall(event, ctx, deps));
    },
  };
}

export function movePolicyLast(base: LoadExtensionsResult): LoadExtensionsResult {
  const policy = base.extensions.find((extension) => extension.path === POLICY_EXTENSION_PATH);
  if (!policy) throw new Error("pap-policy is not loaded: refusing to start the session");
  return { ...base, extensions: [...base.extensions.filter((extension) => extension !== policy), policy] };
}
