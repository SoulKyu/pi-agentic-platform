import { type Caller, type ManualFireResult, PapError } from "@pap/contracts";
import type { Fire } from "./fire.ts";
import { createPrecheckStep, type PrecheckStepDeps } from "./precheck-step.ts";
import type { TriggerRecord } from "./triggers.ts";

export type { PrecheckPort } from "./precheck-step.ts";

export interface ManualDeps extends PrecheckStepDeps {
  readonly fire: Fire;
  readonly triggers: {
    get(ownerId: string, id: string): TriggerRecord | null;
    resolveFolder(cwd: string): string;
  };
}

/**
 * `automation.fire` (M10R63): fires the saved trigger by hand, even a disabled one. The precheck runs after the pause and the budget; a skip is an
 * answer, not an error. The budget gates a token's fire and not the browser's (the owner's action); both are counted.
 * A payload is fenced as the trigger's source would fence it, so a test fire starts tainted like the real one.
 */
export function createManual(deps: ManualDeps) {
  const step = createPrecheckStep(deps);

  return {
    async fire(caller: Caller, triggerId: string, payload: string | undefined): Promise<ManualFireResult> {
      const record = deps.triggers.get(caller.userId, triggerId);
      if (record === null) throw new PapError("not_found");
      const config = record.input;
      // After the pause and the budget (the step hands a refused fire on without a spawn); a token's fire is gated.
      const checked = await step.run(record, {
        source: "manual",
        gated: caller.kind === "token",
        origin: "manual",
      });
      if (checked.kind === "stop") return { verdict: checked.verdict, detail: checked.answer };
      const text = payload === undefined || payload === "" ? null : payload;
      const result = deps.fire(record.id, record.revision, {
        ownerId: caller.userId,
        source: "manual",
        payload:
          text === null ? null : { text, source: config?.source.type === "webhook" ? "webhook" : "manual" },
        precheck: checked.precheck,
        dedupKey: null,
        title: record.name,
        detail: text,
        gated: caller.kind === "token",
        gates: { exemptDisabled: true },
        retry: null,
      });
      switch (result.verdict) {
        case "fired":
          if (result.taskId !== undefined) return { verdict: "fired", taskId: result.taskId };
          break;
        case "paused":
          throw new PapError("automation_paused");
        case "budget":
          throw new PapError("budget_reached");
        case "queue_full":
          throw new PapError("rate_limited");
        case "error":
          return { verdict: "error", detail: result.detail ?? "error" };
        default:
          break;
      }
      deps.logger.error("manual_fire_unexpected", { verdict: result.verdict });
      return { verdict: "error", detail: "error" };
    },
  };
}
export type Manual = ReturnType<typeof createManual>;
