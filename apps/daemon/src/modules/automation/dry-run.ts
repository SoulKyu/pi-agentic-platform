import {
  AUTOMATION_LIMITS,
  type AutomationSettings,
  type Caller,
  type DryRunResult,
  PapError,
  presetOfTools,
  type TriggerInput,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Gates } from "./gates.ts";
import { type PrecheckPort, runPrecheck } from "./precheck-step.ts";
import { type FenceSource, RENDERED_PROMPT_MAX, renderPrompt } from "./prompt.ts";
import type { TaskStore } from "./tasks.ts";
import { type AgentBinding, PRECHECK_AGENT, resolveExecution } from "./trigger-agent.ts";
import type { TriggerRecord } from "./triggers.ts";

export interface DryRunDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly triggers: {
    get(ownerId: string, id: string): TriggerRecord | null;
    resolveFolder(cwd: string): string;
  };
  readonly store: Pick<TaskStore, "queuedOfTrigger">;
  readonly gates: Pick<Gates, "over" | "spentToday">;
  readonly settings: { automation(ownerId: string): AutomationSettings };
  readonly precheck?: PrecheckPort;
  /** The agents' ports (M11): an agent trigger's folder is its home, and its precheck runs in its sandbox. */
  readonly agents?: AgentBinding;
}

export interface DryRunParams {
  readonly triggerId?: string;
  readonly draft?: TriggerInput;
  readonly payload?: string;
}

type Reason = DryRunResult["reasons"][number];

const sameNames = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && [...left].sort().join("\0") === [...right].sort().join("\0");

/**
 * `automation.dryRun` (M10R64): what a fire would do, with nothing written and nothing started: no row, no effect, no
 * session, no tokens, no request (a feed is not fetched; the sample payload stands in). A draft stands in for the saved
 * config. The precheck, the one thing that runs code, runs only for a browser caller and only when the draft keeps the
 * saved trigger's command, resolved folder and variable names (RT-05); a command saved for another folder is never run.
 */
export function createDryRun(deps: DryRunDeps) {
  async function precheckOf(
    caller: Caller,
    saved: TriggerRecord | null,
    config: TriggerInput,
    folder: string | null,
    notRun: "paused" | "budget" | null,
  ): Promise<DryRunResult["precheck"]> {
    const command = config.execution.precheck;
    if (command === null) return null;
    if (caller.kind === "token") return "not_run_token";
    // A paused owner fires nothing, so the command that would gate the fire does not run either (ruling 3).
    if (notRun === "paused") return "not_run_paused";
    // The same for a fire the budget would refuse (the owner's own manual fire is exempt and has no `budget` reason).
    if (notRun === "budget") return "not_run_budget";
    const keeps =
      saved !== null &&
      folder !== null &&
      saved.cwd === folder &&
      saved.input?.execution.precheck === command &&
      sameNames(saved.input.execution.env, config.execution.env);
    if (!keeps) return "not_run_unsaved";
    // Agents run in microVMs: a stored precheck is refused, with the word a fire journals.
    if (saved.agentId !== null)
      return { verdict: "error", exitCode: null, durationMs: 0, output: PRECHECK_AGENT };
    const outcome = await runPrecheck(deps, {
      command,
      cwd: saved.cwd,
      env: config.execution.env,
      triggerId: saved.id,
      origin: "manual",
    });
    if (outcome === null) return null;
    return {
      verdict: outcome.verdict,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      output: outcome.output,
    };
  }

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

      const precheck = await precheckOf(
        caller,
        saved,
        config,
        folder,
        reasons.includes("paused") ? "paused" : reasons.includes("budget") ? "budget" : null,
      );
      if (typeof precheck === "object" && precheck !== null) {
        if (precheck.verdict === "skip") reasons.push("precheck");
        if (precheck.verdict === "error") reasons.push("precheck_error");
      }

      const kind = config.source.type;
      const fenceSource: FenceSource = kind === "webhook" ? "webhook" : kind === "feed" ? "feed" : "manual";
      const sample = params.payload === undefined || params.payload === "" ? null : params.payload;
      const rendered = renderPrompt(config.prompt, {
        payload: sample === null ? null : { text: sample, source: fenceSource },
        precheck: typeof precheck === "object" && precheck?.verdict === "pass" ? precheck.output : null,
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
