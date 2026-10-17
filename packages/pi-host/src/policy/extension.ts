import type {
  ExtensionFactory,
  InlineExtension,
  LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import {
  type EgressReport,
  POLICY_EXTENSION_PATH,
  type PolicyAuditEntry,
  type PolicyRules,
} from "@pap/contracts";
import type { ApprovalAsk, ApprovalOutcome } from "../approvals.ts";
import { homedir } from "node:os";
import { type ShellFacts, UNKNOWN_SHELL } from "./command-cover.ts";
import { egressVerdict } from "./egress-taint.ts";
import { createPolicyGrants } from "./grants.ts";
import { createMessageMix } from "./message-mix.ts";
import { errorClass } from "../bounded.ts";
import { evaluateToolCall, type PipelineDeps } from "./pipeline.ts";
import { restoreStage, unrestoreInput } from "./restore.ts";
import { onToolResult } from "./results.ts";
import { createRunGuard, guardStages } from "./run-guard.ts";
import type { SecretReader } from "./secrets.ts";
import { createExternalRoots, type Taint } from "./taint.ts";
import { classifyTool, SANDBOX_SOURCE, type ToolFacts } from "./tool-kind.ts";

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
  /** The session's own id once Pi has made it (read-target: its attachments). */
  sessionId?(): string | undefined;
  /** The policy's question, on its own record. A closed question blocks the call (M2R66). */
  ask(request: ApprovalAsk, signal?: AbortSignal): Promise<ApprovalOutcome>;
  /** Moves on every policy update, valid or not: a provisional "always" grant ends with it. */
  rulesVersion(): number;
  /** The session's taint: stage 07 raises it, the pipeline reads it. */
  taint: Taint;
  /** The secrets the worker knows (stage 06). */
  secrets: SecretReader;
  /** The worker's home, for `~` in shell commands (Task 1c). */
  home?: string;
  /** The shell facts read-only commands depend on (M7R15); absent: nothing is covered. */
  shell?: () => ShellFacts;
  /** Redacts audit arguments; by default what `secrets` knows. */
  redact?: PipelineDeps["redact"];
  /** The session's sandbox (`init.sandbox`): its network decides whether the sandboxed `bash` taints (M11R25). */
  sandbox?: { readonly network: boolean };
  /** The proxy's reports by tool call id (M11R233), taken once by the result hook; absent: a networked shell's result is external. */
  egress?: { take(toolCallId: string): EgressReport | null | undefined };
  /** Told the tools declared to the model at each `agent_start`; a throw is logged, never raised into the run. */
  onAgentStart?(activeToolNames: string[]): void;
}

export type NamedInlineExtension = Exclude<InlineExtension, ExtensionFactory>;

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
              ...(info.sourceInfo.path === SANDBOX_SOURCE && config.sandbox
                ? { sandboxNetwork: config.sandbox.network }
                : {}),
            }
          : undefined;
      };
      const guard = createRunGuard();
      const roots = createExternalRoots();
      const mix = createMessageMix();
      const { secrets } = config;
      const deps: PipelineDeps = {
        ...config,
        home: config.home ?? homedir(),
        shell: config.shell ?? (() => UNKNOWN_SHELL),
        grants: createPolicyGrants(config.rulesVersion),
        toolFacts,
        taint: config.taint,
        externalRoots: roots,
        messageMix: mix,
        redact: config.redact ?? ((text) => secrets.current().text(text).text),
        redactReason: (text) => secrets.current().textFolded(text).text,
        stages: {
          ...guardStages(guard),
          restore: restoreStage(() => secrets.current().restorable()),
          unrestore: unrestoreInput,
        },
      };
      pi.on("tool_result", (event) =>
        onToolResult(event, {
          secrets,
          taint: config.taint,
          roots,
          audit: config.audit,
          classify: (name) => classifyTool(name, toolFacts(name)),
          ...(config.egress
            ? {
                egress: {
                  check: (id: string) => {
                    return egressVerdict(config.egress?.take(id), config.rules()?.trustedSources ?? []);
                  },
                },
              }
            : {}),
        }),
      );
      pi.on("tool_call", (event, ctx) => evaluateToolCall(event, ctx, deps));
      pi.on("agent_start", () => {
        roots.clear();
        mix.reset();
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
          if (event.message.role === "assistant") {
            mix.reset();
            guard.onTurn();
          }
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
