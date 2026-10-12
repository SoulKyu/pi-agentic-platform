import type {
  ExtensionFactory,
  InlineExtension,
  LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import { POLICY_EXTENSION_PATH, type PolicyAuditEntry, type PolicyRules } from "@pap/contracts";
import type { ApprovalAsk, ApprovalOutcome } from "../approvals.ts";
import { createPolicyGrants } from "./grants.ts";
import { errorClass, evaluateToolCall, type PipelineDeps } from "./pipeline.ts";
import { onToolResult } from "./results.ts";
import { createRunGuard, guardStages } from "./run-guard.ts";
import { NO_REDACTOR } from "./redact.ts";
import type { SecretSource } from "./secrets.ts";
import { classifyTool, type ToolFacts } from "./tool-kind.ts";

export { createPolicyGrants, MAX_SESSION_GRANTS } from "./grants.ts";
export { DENIED_REASON, evaluateToolCall, FAIL_CLOSED_REASON, TOO_LONG_REASON } from "./pipeline.ts";

export const POLICY_EXTENSION_NAME = "pap-policy";

export interface PolicyConfig {
  rules(): PolicyRules | null;
  audit(entry: PolicyAuditEntry): void;
  /** The Pi agent directory of the session: settings, extensions and credentials live there. */
  agentDir: string;
  /** pap's data directory: the database, secrets and agent homes live there. */
  papHome: string;
  /** The policy's question, on its own record. A closed question blocks the call (M2R66). */
  ask(request: ApprovalAsk, signal?: AbortSignal): Promise<ApprovalOutcome>;
  /** Moves on every policy update, valid or not: a provisional "always" grant ends with it. */
  rulesVersion(): number;
  /** Task 9 makes this required. */
  taint?: PipelineDeps["taint"];
  /** The secrets the worker knows (stage 06); none when absent (tests). */
  secrets?: SecretSource;
  /** Redacts audit arguments; by default what `secrets` knows. */
  redact?: PipelineDeps["redact"];
  /** Told the tools declared to the model at each `agent_start`; a throw is logged, never raised into the run. */
  onAgentStart?(activeToolNames: string[]): void;
}

const NO_SOURCE: SecretSource = { current: () => NO_REDACTOR, refresh: () => {} };

type NamedInlineExtension = Exclude<InlineExtension, ExtensionFactory>;

export function createPapPolicyExtension(config: PolicyConfig): NamedInlineExtension {
  return {
    name: POLICY_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      const toolFacts = (name: string): ToolFacts | undefined => {
        const info = pi.getAllTools().find((tool) => tool.name === name);
        return info
          ? {
              path: info.sourceInfo.path,
              ...(info.annotations?.readOnlyHint !== undefined
                ? { readOnlyHint: info.annotations.readOnlyHint }
                : {}),
              ...(info.annotations?.openWorldHint !== undefined
                ? { openWorldHint: info.annotations.openWorldHint }
                : {}),
            }
          : undefined;
      };
      const guard = createRunGuard();
      const secrets = config.secrets ?? NO_SOURCE;
      const deps: PipelineDeps = {
        ...config,
        grants: createPolicyGrants(config.rulesVersion),
        toolFacts,
        taint: config.taint ?? { current: () => false },
        redact: config.redact ?? ((text) => secrets.current().text(text).text),
        stages: guardStages(guard),
      };
      pi.on("tool_result", (event) =>
        onToolResult(event, {
          secrets,
          audit: config.audit,
          classify: (name) => classifyTool(name, toolFacts(name)),
        }),
      );
      pi.on("tool_call", (event, ctx) => evaluateToolCall(event, ctx, deps));
      pi.on("agent_start", () => {
        try {
          guard.onRunStart();
        } catch (error) {
          process.stderr.write(`pi-host: run guard failed (${errorClass(error)})\n`);
        }
        try {
          config.onAgentStart?.(pi.getActiveTools());
        } catch (error) {
          process.stderr.write(`pi-host: session entry failed (${errorClass(error)})\n`);
        }
      });
      pi.on("message_end", (event) => {
        try {
          if (event.message.role === "assistant") guard.onTurn();
        } catch (error) {
          process.stderr.write(`pi-host: run guard failed (${errorClass(error)})\n`);
        }
      });
    },
  };
}

export function movePolicyLast(base: LoadExtensionsResult): LoadExtensionsResult {
  const policy = base.extensions.find((extension) => extension.path === POLICY_EXTENSION_PATH);
  if (!policy) throw new Error("pap-policy is not loaded: refusing to start the session");
  return { ...base, extensions: [...base.extensions.filter((extension) => extension !== policy), policy] };
}
