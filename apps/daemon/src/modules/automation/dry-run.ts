import {
  AUTOMATION_LIMITS,
  type AutomationSettings,
  type Caller,
  type DryRunResult,
  PapError,
  presetOfTools,
  PRECHECK_REMOVED,
  type TriggerInput,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Gates } from "./gates.ts";
import { type FenceSource, RENDERED_PROMPT_MAX, renderPrompt } from "./prompt.ts";
import type { TaskStore } from "./tasks.ts";
import { type AgentBinding, resolveExecution } from "./trigger-agent.ts";
import type { TriggerRecord } from "./triggers.ts";

export interface DryRunDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly triggers: {
    get(ownerId: string, id: string): TriggerRecord | null;
    resolveFolder(cwd: string, ownerId: string): string;
  };
  readonly store: Pick<TaskStore, "queuedOfTrigger">;
  readonly gates: Pick<Gates, "over" | "spentToday">;
  readonly settings: { automation(ownerId: string): AutomationSettings };
  /** The agents' ports (M11): an agent trigger's folder is its home. */
  readonly agents?: AgentBinding;
}

export interface DryRunParams {
  readonly triggerId?: string;
  readonly draft?: TriggerInput;
  readonly payload?: string;
}

type Reason = DryRunResult["reasons"][number];

/**
 * `automation.dryRun` (M10R64): what a fire would do, with nothing written and nothing started: no row, no effect, no
 * session, no tokens, no request (a feed is not fetched; the sample payload stands in). A draft stands in for the saved
 * config. A precheck in the config is answered as an error with the word a fire journals: nothing runs (B6).
 */
export function createDryRun(deps: DryRunDeps) {
  return {
    async run(caller: Caller, params: DryRunParams): Promise<DryRunResult> {
      const ownerId = caller.userId;
      const saved = params.triggerId === undefined ? null : deps.triggers.get(ownerId, params.triggerId);
      if (params.triggerId !== undefined && saved === null) throw new PapError("not_found");
      const config = params.draft ?? saved?.input ?? null;
      if (config === null) throw new PapError("bad_request");
      // The agent's thread is trusted: the manual fire refuses outside text and a token for it, so the dry run does too.
      if (config.execution.agent?.target === "thread") {
        if (params.payload !== undefined && params.payload !== "") throw new PapError("bad_request");
        if (caller.kind === "token") throw new PapError("forbidden");
      }

      const reasons: Reason[] = [];
      let folder: string | null = null;
      try {
        folder = resolveExecution(deps.agents, ownerId, config.execution, deps.triggers.resolveFolder).cwd;
      } catch (error) {
        if (!(error instanceof PapError && error.code === "invalid_cwd")) throw error;
        reasons.push("invalid_cwd");
      }

      const settings = deps.settings.automation(ownerId);
      if (settings.paused) reasons.push("paused");
      // The budget gates a token's fire and any source that fires by itself; the owner's own manual fire is exempt.
      if (
        (caller.kind === "token" || config.source.type !== "manual") &&
        deps.gates.over(ownerId, saved?.id ?? null)
      )
        reasons.push("budget");
      if (saved !== null && deps.store.queuedOfTrigger(saved.id) >= AUTOMATION_LIMITS.queuedPerTrigger)
        reasons.push("queue_full");

      const precheck: DryRunResult["precheck"] =
        config.execution.precheck === null
          ? null
          : { verdict: "error", exitCode: null, durationMs: 0, output: PRECHECK_REMOVED };
      if (precheck !== null) reasons.push("precheck_error");

      const kind = config.source.type;
      const fenceSource: FenceSource = kind === "webhook" ? "webhook" : kind === "feed" ? "feed" : "manual";
      const sample = params.payload === undefined || params.payload === "" ? null : params.payload;
      const rendered = renderPrompt(config.prompt, {
        payload: sample === null ? null : { text: sample, source: fenceSource },
        trigger: saved?.name ?? config.name,
        firedAt: new Date(deps.clock.now()).toISOString(),
      });
      const tooLarge = rendered.text.length > RENDERED_PROMPT_MAX;
      if (tooLarge) reasons.push("prompt_too_large");

      const { tools, mode } = config.execution;
      return {
        verdict: reasons.length === 0 ? "fire" : "skip",
        reasons,
        tools: [...tools],
        profile: {
          preset: presetOfTools(tools),
          mode: mode ?? "supervised",
          tainted: rendered.fenced,
          editsUnasked:
            mode === "auto-accept-edits" && tools.some((tool) => tool === "edit" || tool === "write"),
        },
        cwd: folder ?? config.execution.cwd ?? "",
        prompt: tooLarge ? rendered.text.slice(0, RENDERED_PROMPT_MAX) : rendered.text,
        precheck,
        budget: { spentUsd: deps.gates.spentToday(ownerId), budgetUsd: settings.dailyBudgetUsd },
        tokens: "none",
        feed: kind === "feed" ? "not_fetched" : null,
      };
    },
  };
}
export type DryRun = ReturnType<typeof createDryRun>;
